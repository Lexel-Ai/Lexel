"""Token-masked preference optimization loss functions (`MaskedSimPOLoss` and `MaskedDPOLoss`).

Ported from `/home/lawand/Prose/src/wlab/loss.py`:
- Reference-free, length-normalized `MaskedSimPOLoss` with surgical token masking.
- Reference-based `MaskedDPOLoss` with surgical token masking.
- Dual-band token weighting (`unmasked_token_weight = alpha in [0.0, 1.0]`):
  when `alpha = 0.0`, gradients on unmasked (`mask == 0`) rejected tokens are identically `0.0`.
- Works seamlessly with both PyTorch `torch.Tensor` (when `torch` is installed) and pure-Python nested lists/sequences for offline CPU verification without GPU dependencies.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F

    HAS_TORCH = True
except ImportError:  # pragma: no cover
    torch = None  # type: ignore[assignment]
    nn = None  # type: ignore[assignment]
    F = None  # type: ignore[assignment]
    HAS_TORCH = False


def _is_torch_tensor(x: Any) -> bool:
    return HAS_TORCH and isinstance(x, torch.Tensor)


def _scalar_float(val: Any) -> float:
    if _is_torch_tensor(val):
        return float(val.detach().mean().cpu().item())
    if isinstance(val, (list, tuple)):
        return sum(float(v) for v in val) / max(1, len(val))
    return float(val)


@dataclass
class LossOutput:
    """Output bundle from preference loss computation."""

    loss: Any
    chosen_rewards: Any
    rejected_rewards: Any
    reward_margin: Any
    accuracy: Any
    nll_loss: Any | None = None
    rejected_token_gradients: list[list[float]] = field(default_factory=list)

    def to_metrics(self) -> dict[str, float]:
        """Extract scalar floats for logging and telemetry."""
        m: dict[str, float] = {
            "loss": _scalar_float(self.loss),
            "chosen_reward": _scalar_float(self.chosen_rewards),
            "rejected_reward": _scalar_float(self.rejected_rewards),
            "reward_margin": _scalar_float(self.reward_margin),
            "accuracy": _scalar_float(self.accuracy),
        }
        if self.nll_loss is not None:
            m["nll_loss"] = _scalar_float(self.nll_loss)
        return m


def _log_softmax_1d(vec: list[float]) -> list[float]:
    max_v = max(vec)
    exps = [math.exp(v - max_v) for v in vec]
    log_sum = math.log(sum(exps))
    return [(v - max_v) - log_sum for v in vec]


def _logsigmoid_scalar(x: float) -> float:
    if x >= 0:
        return -math.log1p(math.exp(-x))
    return x - math.log1p(math.exp(x))


def _sigmoid_scalar(x: float) -> float:
    if x >= 0:
        z = math.exp(-x)
        return 1.0 / (1.0 + z)
    z = math.exp(x)
    return z / (1.0 + z)


def compute_token_logprobs(
    logits: Any,
    labels: Any,
) -> Any:
    """Compute per-token log-probabilities `log p(y_t | y_<t)` of target tokens.

    Args:
        logits: Tensor or nested list of shape `(B, L, V)`.
        labels: Tensor or nested list of shape `(B, L)` with prompt/pad tokens masked as `-100`.

    Returns:
        Tensor or nested list of shape `(B, L - 1)` containing `log p(y_t | y_<t)`.
    """
    if _is_torch_tensor(logits):
        shift_logits = logits[..., :-1, :].contiguous()
        shift_labels = labels[..., 1:].contiguous()
        clamped_labels = torch.clamp(shift_labels, min=0)
        log_probs = F.log_softmax(shift_logits, dim=-1)
        per_token_logprobs = torch.gather(
            log_probs, dim=-1, index=clamped_labels.unsqueeze(-1)
        ).squeeze(-1)
        valid_mask = (shift_labels != -100).to(per_token_logprobs.dtype)
        return per_token_logprobs * valid_mask

    # Pure-Python implementation for shape (B, L, V)
    batch_out: list[list[float]] = []
    for b_idx, seq_logits in enumerate(logits):
        seq_labels = labels[b_idx]
        seq_out: list[float] = []
        for t in range(len(seq_logits) - 1):
            target_lbl = int(seq_labels[t + 1])
            if target_lbl == -100:
                seq_out.append(0.0)
            else:
                lprobs = _log_softmax_1d([float(v) for v in seq_logits[t]])
                seq_out.append(lprobs[target_lbl])
        batch_out.append(seq_out)
    return batch_out


class MaskedSimPOLoss:
    """Simple Preference Optimization with Surgical Token Masking (Mask-SimPO).

    Formulation:
        r_w = (beta / (sum w_w + eps)) * sum_t w_{w, t} * log pi(y_{w, t} | x, y_{w, <t})
        r_l = (beta / (sum w_l + eps)) * sum_t w_{l, t} * log pi(y_{l, t} | x, y_{l, <t})
        loss = -log sigmoid(r_w - r_l - gamma)
    """

    def __init__(
        self,
        beta: float = 2.0,
        gamma: float = 1.0,
        unmasked_token_weight: float = 0.0,
        sft_weight: float = 0.0,
        label_smoothing: float = 0.0,
        eps: float = 1e-8,
    ) -> None:
        self.beta = beta
        self.gamma = gamma
        self.unmasked_token_weight = unmasked_token_weight
        self.sft_weight = sft_weight
        self.label_smoothing = label_smoothing
        self.eps = eps

    def __call__(
        self,
        chosen_logits: Any,
        chosen_labels: Any,
        rejected_logits: Any,
        rejected_labels: Any,
        rejected_token_mask: Any | None = None,
        chosen_token_mask: Any | None = None,
    ) -> LossOutput:
        return self.forward(
            chosen_logits=chosen_logits,
            chosen_labels=chosen_labels,
            rejected_logits=rejected_logits,
            rejected_labels=rejected_labels,
            rejected_token_mask=rejected_token_mask,
            chosen_token_mask=chosen_token_mask,
        )

    def forward(
        self,
        chosen_logits: Any,
        chosen_labels: Any,
        rejected_logits: Any,
        rejected_labels: Any,
        rejected_token_mask: Any | None = None,
        chosen_token_mask: Any | None = None,
    ) -> LossOutput:
        if _is_torch_tensor(chosen_logits):
            return self._forward_torch(
                chosen_logits=chosen_logits,
                chosen_labels=chosen_labels,
                rejected_logits=rejected_logits,
                rejected_labels=rejected_labels,
                rejected_token_mask=rejected_token_mask,
                chosen_token_mask=chosen_token_mask,
            )
        return self._forward_python(
            chosen_logits=chosen_logits,
            chosen_labels=chosen_labels,
            rejected_logits=rejected_logits,
            rejected_labels=rejected_labels,
            rejected_token_mask=rejected_token_mask,
            chosen_token_mask=chosen_token_mask,
        )

    def _forward_torch(
        self,
        chosen_logits: Any,
        chosen_labels: Any,
        rejected_logits: Any,
        rejected_labels: Any,
        rejected_token_mask: Any | None = None,
        chosen_token_mask: Any | None = None,
    ) -> LossOutput:
        chosen_logprobs = compute_token_logprobs(chosen_logits, chosen_labels)
        rejected_logprobs = compute_token_logprobs(
            rejected_logits, rejected_labels
        )

        chosen_valid = (chosen_labels[..., 1:] != -100).to(
            chosen_logprobs.dtype
        )
        rejected_valid = (rejected_labels[..., 1:] != -100).to(
            rejected_logprobs.dtype
        )

        if chosen_token_mask is not None:
            shift_chosen_mask = chosen_token_mask[..., 1:].to(
                chosen_logprobs.dtype
            )
            chosen_w = chosen_valid * (
                self.unmasked_token_weight
                + (1.0 - self.unmasked_token_weight) * shift_chosen_mask
            )
        else:
            chosen_w = chosen_valid

        if rejected_token_mask is not None:
            shift_rejected_mask = rejected_token_mask[..., 1:].to(
                rejected_logprobs.dtype
            )
            rejected_w = rejected_valid * (
                self.unmasked_token_weight
                + (1.0 - self.unmasked_token_weight) * shift_rejected_mask
            )
        else:
            rejected_w = rejected_valid

        chosen_denom = chosen_w.sum(dim=-1).clamp(min=self.eps)
        rejected_denom = rejected_w.sum(dim=-1).clamp(min=self.eps)

        chosen_rewards = (
            self.beta * (chosen_logprobs * chosen_w).sum(dim=-1) / chosen_denom
        )
        rejected_rewards = (
            self.beta
            * (rejected_logprobs * rejected_w).sum(dim=-1)
            / rejected_denom
        )

        margin = chosen_rewards - rejected_rewards - self.gamma

        if self.label_smoothing > 0.0:
            loss = (
                -(1.0 - self.label_smoothing) * F.logsigmoid(margin)
                - self.label_smoothing * F.logsigmoid(-margin)
            ).mean()
        else:
            loss = (-F.logsigmoid(margin)).mean()

        nll_loss = None
        if self.sft_weight > 0.0:
            nll_loss = -(chosen_logprobs * chosen_valid).sum(
                dim=-1
            ) / chosen_valid.sum(dim=-1).clamp(min=self.eps)
            loss = loss + self.sft_weight * nll_loss.mean()

        accuracy = (chosen_rewards > rejected_rewards).to(torch.float32)

        return LossOutput(
            loss=loss,
            chosen_rewards=chosen_rewards,
            rejected_rewards=rejected_rewards,
            reward_margin=chosen_rewards - rejected_rewards,
            accuracy=accuracy,
            nll_loss=nll_loss,
        )

    def _forward_python(
        self,
        chosen_logits: list[list[list[float]]],
        chosen_labels: list[list[int]],
        rejected_logits: list[list[list[float]]],
        rejected_labels: list[list[int]],
        rejected_token_mask: list[list[int]] | None = None,
        chosen_token_mask: list[list[int]] | None = None,
    ) -> LossOutput:
        chosen_logprobs = compute_token_logprobs(chosen_logits, chosen_labels)
        rejected_logprobs = compute_token_logprobs(
            rejected_logits, rejected_labels
        )

        batch_size = len(chosen_logprobs)
        chosen_rewards: list[float] = []
        rejected_rewards: list[float] = []
        margins: list[float] = []
        losses: list[float] = []
        nll_losses: list[float] = []
        accuracies: list[float] = []
        rejected_grads: list[list[float]] = []

        for b in range(batch_size):
            c_lp = chosen_logprobs[b]
            r_lp = rejected_logprobs[b]
            c_valid = [
                1.0 if int(lbl) != -100 else 0.0
                for lbl in chosen_labels[b][1:]
            ]
            r_valid = [
                1.0 if int(lbl) != -100 else 0.0
                for lbl in rejected_labels[b][1:]
            ]

            if chosen_token_mask is not None:
                c_mask = [float(m) for m in chosen_token_mask[b][1:]]
                c_w = [
                    v
                    * (
                        self.unmasked_token_weight
                        + (1.0 - self.unmasked_token_weight) * m
                    )
                    for v, m in zip(c_valid, c_mask)
                ]
            else:
                c_w = c_valid

            if rejected_token_mask is not None:
                r_mask = [float(m) for m in rejected_token_mask[b][1:]]
                r_w = [
                    v
                    * (
                        self.unmasked_token_weight
                        + (1.0 - self.unmasked_token_weight) * m
                    )
                    for v, m in zip(r_valid, r_mask)
                ]
            else:
                r_w = r_valid

            c_denom = max(self.eps, sum(c_w))
            r_denom = max(self.eps, sum(r_w))

            r_w_val = (
                self.beta
                * sum(lp * w for lp, w in zip(c_lp, c_w))
                / c_denom
            )
            r_l_val = (
                self.beta
                * sum(lp * w for lp, w in zip(r_lp, r_w))
                / r_denom
            )

            margin = r_w_val - r_l_val - self.gamma
            if self.label_smoothing > 0.0:
                sample_loss = -(
                    1.0 - self.label_smoothing
                ) * _logsigmoid_scalar(margin) - self.label_smoothing * _logsigmoid_scalar(
                    -margin
                )
            else:
                sample_loss = -_logsigmoid_scalar(margin)

            if self.sft_weight > 0.0:
                c_valid_denom = max(self.eps, sum(c_valid))
                sample_nll = (
                    -sum(lp * v for lp, v in zip(c_lp, c_valid)) / c_valid_denom
                )
                nll_losses.append(sample_nll)
                sample_loss += self.sft_weight * sample_nll

            # Analytical gradient d(loss)/d(rejected_logprob_t):
            # d(-log sigmoid(margin))/d(r_l) = 1 - sigmoid(margin) = sigmoid(-margin)
            # d(r_l)/d(r_lp_t) = beta * r_w_t / r_denom
            dloss_drl = _sigmoid_scalar(-margin) / max(1, batch_size)
            token_grad = [
                dloss_drl * (self.beta * w / r_denom) for w in r_w
            ]
            rejected_grads.append(token_grad)

            chosen_rewards.append(r_w_val)
            rejected_rewards.append(r_l_val)
            margins.append(r_w_val - r_l_val)
            losses.append(sample_loss)
            accuracies.append(1.0 if r_w_val > r_l_val else 0.0)

        mean_loss = sum(losses) / max(1, batch_size)
        mean_nll = (
            (sum(nll_losses) / max(1, len(nll_losses)))
            if self.sft_weight > 0.0
            else None
        )
        return LossOutput(
            loss=mean_loss,
            chosen_rewards=chosen_rewards,
            rejected_rewards=rejected_rewards,
            reward_margin=margins,
            accuracy=accuracies,
            nll_loss=mean_nll,
            rejected_token_gradients=rejected_grads,
        )


class MaskedDPOLoss:
    """Direct Preference Optimization with Surgical Token Masking (Mask-DPO)."""

    def __init__(
        self,
        beta: float = 0.1,
        unmasked_token_weight: float = 0.0,
        label_smoothing: float = 0.0,
        eps: float = 1e-8,
    ) -> None:
        self.beta = beta
        self.unmasked_token_weight = unmasked_token_weight
        self.label_smoothing = label_smoothing
        self.eps = eps

    def __call__(
        self,
        policy_chosen_logits: Any,
        policy_rejected_logits: Any,
        reference_chosen_logits: Any,
        reference_rejected_logits: Any,
        chosen_labels: Any,
        rejected_labels: Any,
        rejected_token_mask: Any | None = None,
        chosen_token_mask: Any | None = None,
    ) -> LossOutput:
        return self.forward(
            policy_chosen_logits=policy_chosen_logits,
            policy_rejected_logits=policy_rejected_logits,
            reference_chosen_logits=reference_chosen_logits,
            reference_rejected_logits=reference_rejected_logits,
            chosen_labels=chosen_labels,
            rejected_labels=rejected_labels,
            rejected_token_mask=rejected_token_mask,
            chosen_token_mask=chosen_token_mask,
        )

    def forward(
        self,
        policy_chosen_logits: Any,
        policy_rejected_logits: Any,
        reference_chosen_logits: Any,
        reference_rejected_logits: Any,
        chosen_labels: Any,
        rejected_labels: Any,
        rejected_token_mask: Any | None = None,
        chosen_token_mask: Any | None = None,
    ) -> LossOutput:
        if _is_torch_tensor(policy_chosen_logits):
            return self._forward_torch(
                policy_chosen_logits=policy_chosen_logits,
                policy_rejected_logits=policy_rejected_logits,
                reference_chosen_logits=reference_chosen_logits,
                reference_rejected_logits=reference_rejected_logits,
                chosen_labels=chosen_labels,
                rejected_labels=rejected_labels,
                rejected_token_mask=rejected_token_mask,
                chosen_token_mask=chosen_token_mask,
            )
        return self._forward_python(
            policy_chosen_logits=policy_chosen_logits,
            policy_rejected_logits=policy_rejected_logits,
            reference_chosen_logits=reference_chosen_logits,
            reference_rejected_logits=reference_rejected_logits,
            chosen_labels=chosen_labels,
            rejected_labels=rejected_labels,
            rejected_token_mask=rejected_token_mask,
            chosen_token_mask=chosen_token_mask,
        )

    def _forward_torch(
        self,
        policy_chosen_logits: Any,
        policy_rejected_logits: Any,
        reference_chosen_logits: Any,
        reference_rejected_logits: Any,
        chosen_labels: Any,
        rejected_labels: Any,
        rejected_token_mask: Any | None = None,
        chosen_token_mask: Any | None = None,
    ) -> LossOutput:
        pi_c = compute_token_logprobs(policy_chosen_logits, chosen_labels)
        pi_r = compute_token_logprobs(policy_rejected_logits, rejected_labels)
        ref_c = compute_token_logprobs(reference_chosen_logits, chosen_labels)
        ref_r = compute_token_logprobs(
            reference_rejected_logits, rejected_labels
        )

        diff_c = pi_c - ref_c
        diff_r = pi_r - ref_r

        chosen_valid = (chosen_labels[..., 1:] != -100).to(pi_c.dtype)
        rejected_valid = (rejected_labels[..., 1:] != -100).to(pi_r.dtype)

        if chosen_token_mask is not None:
            chosen_w = chosen_valid * (
                self.unmasked_token_weight
                + (1.0 - self.unmasked_token_weight)
                * chosen_token_mask[..., 1:].to(pi_c.dtype)
            )
        else:
            chosen_w = chosen_valid

        if rejected_token_mask is not None:
            rejected_w = rejected_valid * (
                self.unmasked_token_weight
                + (1.0 - self.unmasked_token_weight)
                * rejected_token_mask[..., 1:].to(pi_r.dtype)
            )
        else:
            rejected_w = rejected_valid

        chosen_denom = chosen_w.sum(dim=-1).clamp(min=self.eps)
        rejected_denom = rejected_w.sum(dim=-1).clamp(min=self.eps)

        chosen_rewards = (
            self.beta * (diff_c * chosen_w).sum(dim=-1) / chosen_denom
        )
        rejected_rewards = (
            self.beta * (diff_r * rejected_w).sum(dim=-1) / rejected_denom
        )

        logits = chosen_rewards - rejected_rewards
        if self.label_smoothing > 0.0:
            loss = (
                -(1.0 - self.label_smoothing) * F.logsigmoid(logits)
                - self.label_smoothing * F.logsigmoid(-logits)
            ).mean()
        else:
            loss = (-F.logsigmoid(logits)).mean()

        accuracy = (chosen_rewards > rejected_rewards).to(torch.float32)

        return LossOutput(
            loss=loss,
            chosen_rewards=chosen_rewards,
            rejected_rewards=rejected_rewards,
            reward_margin=logits,
            accuracy=accuracy,
        )

    def _forward_python(
        self,
        policy_chosen_logits: list[list[list[float]]],
        policy_rejected_logits: list[list[list[float]]],
        reference_chosen_logits: list[list[list[float]]],
        reference_rejected_logits: list[list[list[float]]],
        chosen_labels: list[list[int]],
        rejected_labels: list[list[int]],
        rejected_token_mask: list[list[int]] | None = None,
        chosen_token_mask: list[list[int]] | None = None,
    ) -> LossOutput:
        pi_c = compute_token_logprobs(policy_chosen_logits, chosen_labels)
        pi_r = compute_token_logprobs(policy_rejected_logits, rejected_labels)
        ref_c = compute_token_logprobs(reference_chosen_logits, chosen_labels)
        ref_r = compute_token_logprobs(
            reference_rejected_logits, rejected_labels
        )

        batch_size = len(pi_c)
        chosen_rewards: list[float] = []
        rejected_rewards: list[float] = []
        margins: list[float] = []
        losses: list[float] = []
        accuracies: list[float] = []
        rejected_grads: list[list[float]] = []

        for b in range(batch_size):
            diff_c = [p - r for p, r in zip(pi_c[b], ref_c[b])]
            diff_r = [p - r for p, r in zip(pi_r[b], ref_r[b])]

            c_valid = [
                1.0 if int(lbl) != -100 else 0.0
                for lbl in chosen_labels[b][1:]
            ]
            r_valid = [
                1.0 if int(lbl) != -100 else 0.0
                for lbl in rejected_labels[b][1:]
            ]

            if chosen_token_mask is not None:
                c_mask = [float(m) for m in chosen_token_mask[b][1:]]
                c_w = [
                    v
                    * (
                        self.unmasked_token_weight
                        + (1.0 - self.unmasked_token_weight) * m
                    )
                    for v, m in zip(c_valid, c_mask)
                ]
            else:
                c_w = c_valid

            if rejected_token_mask is not None:
                r_mask = [float(m) for m in rejected_token_mask[b][1:]]
                r_w = [
                    v
                    * (
                        self.unmasked_token_weight
                        + (1.0 - self.unmasked_token_weight) * m
                    )
                    for v, m in zip(r_valid, r_mask)
                ]
            else:
                r_w = r_valid

            c_denom = max(self.eps, sum(c_w))
            r_denom = max(self.eps, sum(r_w))

            r_w_val = (
                self.beta
                * sum(d * w for d, w in zip(diff_c, c_w))
                / c_denom
            )
            r_l_val = (
                self.beta
                * sum(d * w for d, w in zip(diff_r, r_w))
                / r_denom
            )

            margin = r_w_val - r_l_val
            if self.label_smoothing > 0.0:
                sample_loss = -(
                    1.0 - self.label_smoothing
                ) * _logsigmoid_scalar(margin) - self.label_smoothing * _logsigmoid_scalar(
                    -margin
                )
            else:
                sample_loss = -_logsigmoid_scalar(margin)

            dloss_drl = _sigmoid_scalar(-margin) / max(1, batch_size)
            token_grad = [
                dloss_drl * (self.beta * w / r_denom) for w in r_w
            ]
            rejected_grads.append(token_grad)

            chosen_rewards.append(r_w_val)
            rejected_rewards.append(r_l_val)
            margins.append(margin)
            losses.append(sample_loss)
            accuracies.append(1.0 if r_w_val > r_l_val else 0.0)

        return LossOutput(
            loss=sum(losses) / max(1, batch_size),
            chosen_rewards=chosen_rewards,
            rejected_rewards=rejected_rewards,
            reward_margin=margins,
            accuracy=accuracies,
            rejected_token_gradients=rejected_grads,
        )
