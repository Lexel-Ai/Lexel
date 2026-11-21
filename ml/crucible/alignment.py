"""Production Kaggle & Unsloth preference alignment trainer using `MaskedSimPOLoss` and `MaskedDPOLoss`.

Provides:
- `PreferenceBatchCollator`: Tokenizes ChatML `(messages, chosen, rejected, rejected_token_mask)`
  into padded PyTorch tensors (or pure-Python lists when `torch` is absent), aligning `rejected_token_mask`
  with the tokenized completion tokens and setting `-100` on prompt and padding positions.
- `run_masked_simpo_alignment`: End-to-end training loop over surgical counterfactual pairs using
  `MaskedSimPOLoss` with 8-bit AdamW (or standard PyTorch AdamW fallback), cosine warmup scheduler,
  gradient accumulation, and gradient clipping, returning auditable step metrics.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any, Sequence

from ml.crucible.collator import _render_chatml_prompt_and_completion
from ml.crucible.counterfactual import align_spans_to_token_mask
from ml.crucible.loss import HAS_TORCH, MaskedSimPOLoss, torch


@dataclass
class AlignmentSummary:
    steps_completed: int
    epochs_completed: int
    final_loss: float
    mean_loss: float
    final_reward_margin: float
    final_accuracy: float
    wall_time_sec: float
    history: list[dict[str, float]] = field(default_factory=list)


class PreferenceBatchCollator:
    """Collate surgical counterfactual preference pairs with exact token-level masks."""

    def __init__(
        self,
        tokenizer: Any,
        max_seq_length: int = 1536,
        pad_to_multiple_of: int = 8,
        return_tensors: str = "auto",
    ) -> None:
        self.tokenizer = tokenizer
        self.max_seq_length = max_seq_length
        self.pad_to_multiple_of = pad_to_multiple_of
        self.return_tensors = return_tensors
        self.pad_token_id = int(
            getattr(tokenizer, "pad_token_id", None)
            or getattr(tokenizer, "eos_token_id", None)
            or 0
        )

    def _to_tensor(self, data: Any, dtype_name: str = "long") -> Any:
        if self.return_tensors == "list" or not HAS_TORCH:
            return data
        dtype = torch.float32 if dtype_name == "float32" else torch.long
        return torch.tensor(data, dtype=dtype)

    def _encode_pair(self, row: dict[str, Any]) -> dict[str, list[int]]:
        messages = list(row.get("messages") or [])
        chosen_text = str(row["chosen"]).strip()
        rejected_text = str(row["rejected"]).strip()

        if messages:
            chosen_msgs = [*messages, {"role": "assistant", "content": chosen_text}]
            prompt_str, chosen_comp_str = _render_chatml_prompt_and_completion(chosen_msgs)
            _, rejected_comp_str = _render_chatml_prompt_and_completion(
                [*messages, {"role": "assistant", "content": rejected_text}]
            )
        else:
            prompt_raw = str(row.get("prompt") or "").strip()
            prompt_str = f"<|im_start|>user\n{prompt_raw}<|im_end|>\n<|im_start|>assistant\n"
            chosen_comp_str = f"{chosen_text}<|im_end|>\n"
            rejected_comp_str = f"{rejected_text}<|im_end|>\n"

        prompt_ids = list(self.tokenizer.encode(prompt_str, add_special_tokens=False))
        chosen_ids = list(self.tokenizer.encode(chosen_comp_str, add_special_tokens=False))
        rejected_ids = list(self.tokenizer.encode(rejected_comp_str, add_special_tokens=False))

        max_prompt = max(64, self.max_seq_length - max(len(chosen_ids), len(rejected_ids), 64))
        if len(prompt_ids) > max_prompt:
            prompt_ids = prompt_ids[:max_prompt]

        c_input = (prompt_ids + chosen_ids)[: self.max_seq_length]
        c_labels = ([-100] * len(prompt_ids) + chosen_ids)[: self.max_seq_length]
        c_mask = ([0] * len(prompt_ids) + [1] * len(chosen_ids))[: self.max_seq_length]

        r_input = (prompt_ids + rejected_ids)[: self.max_seq_length]
        r_labels = ([-100] * len(prompt_ids) + rejected_ids)[: self.max_seq_length]

        spans = row.get("perturbed_spans") or []
        if spans:
            comp_mask = align_spans_to_token_mask(self.tokenizer, rejected_text, spans)
        else:
            comp_mask = [int(v) for v in (row.get("rejected_token_mask") or [])]

        if len(comp_mask) < len(rejected_ids):
            comp_mask = comp_mask + [0] * (len(rejected_ids) - len(comp_mask))
        elif len(comp_mask) > len(rejected_ids):
            comp_mask = comp_mask[: len(rejected_ids)]

        if not any(m > 0 for m in comp_mask) and rejected_ids:
            comp_mask = [1] * len(rejected_ids)

        r_mask = ([0] * len(prompt_ids) + comp_mask)[: self.max_seq_length]
        # If truncation clipped past the mutated span, fall back to the retained completion tokens
        if not any(m > 0 for m in r_mask) and len(r_mask) > len(prompt_ids):
            for idx in range(len(prompt_ids), len(r_mask)):
                r_mask[idx] = 1

        return {
            "chosen_input_ids": c_input,
            "chosen_labels": c_labels,
            "chosen_token_mask": c_mask,
            "rejected_input_ids": r_input,
            "rejected_labels": r_labels,
            "rejected_token_mask": r_mask,
        }

    def __call__(self, features: Sequence[dict[str, Any]]) -> dict[str, Any]:
        if not features:
            raise ValueError("Empty features passed to PreferenceBatchCollator")

        encoded = [self._encode_pair(f) for f in features]

        max_c = max(len(e["chosen_input_ids"]) for e in encoded)
        if self.pad_to_multiple_of and max_c % self.pad_to_multiple_of != 0:
            max_c = ((max_c // self.pad_to_multiple_of) + 1) * self.pad_to_multiple_of

        max_r = max(len(e["rejected_input_ids"]) for e in encoded)
        if self.pad_to_multiple_of and max_r % self.pad_to_multiple_of != 0:
            max_r = ((max_r // self.pad_to_multiple_of) + 1) * self.pad_to_multiple_of

        c_inputs, c_attns, c_labels, c_masks = [], [], [], []
        r_inputs, r_attns, r_labels, r_masks = [], [], [], []

        for e in encoded:
            c_len = len(e["chosen_input_ids"])
            c_pad = max_c - c_len
            c_inputs.append(e["chosen_input_ids"] + [self.pad_token_id] * c_pad)
            c_attns.append([1] * c_len + [0] * c_pad)
            c_labels.append(e["chosen_labels"] + [-100] * c_pad)
            c_masks.append(e["chosen_token_mask"] + [0] * c_pad)

            r_len = len(e["rejected_input_ids"])
            r_pad = max_r - r_len
            r_inputs.append(e["rejected_input_ids"] + [self.pad_token_id] * r_pad)
            r_attns.append([1] * r_len + [0] * r_pad)
            r_labels.append(e["rejected_labels"] + [-100] * r_pad)
            r_masks.append(e["rejected_token_mask"] + [0] * r_pad)

        return {
            "chosen_input_ids": self._to_tensor(c_inputs, "long"),
            "chosen_attention_mask": self._to_tensor(c_attns, "long"),
            "chosen_labels": self._to_tensor(c_labels, "long"),
            "chosen_token_mask": self._to_tensor(c_masks, "float32"),
            "rejected_input_ids": self._to_tensor(r_inputs, "long"),
            "rejected_attention_mask": self._to_tensor(r_attns, "long"),
            "rejected_labels": self._to_tensor(r_labels, "long"),
            "rejected_token_mask": self._to_tensor(r_masks, "float32"),
        }


def run_masked_simpo_alignment(
    model: Any,
    tokenizer: Any,
    pairs: Sequence[dict[str, Any]],
    *,
    beta: float = 2.0,
    gamma: float = 1.0,
    sft_weight: float = 0.05,
    unmasked_token_weight: float = 0.05,
    learning_rate: float = 5e-6,
    weight_decay: float = 0.01,
    warmup_ratio: float = 0.10,
    num_train_epochs: float = 1.5,
    per_device_batch_size: int = 2,
    gradient_accumulation_steps: int = 4,
    max_seq_length: int = 1536,
    logging_steps: int = 10,
    max_steps: int = -1,
) -> AlignmentSummary:
    """Run Stage 2 surgical token-masked SimPO alignment on `model`."""
    if not HAS_TORCH:
        raise RuntimeError("PyTorch is required to execute run_masked_simpo_alignment")

    collator = PreferenceBatchCollator(
        tokenizer=tokenizer,
        max_seq_length=max_seq_length,
        pad_to_multiple_of=8,
        return_tensors="pt",
    )
    loss_fn = MaskedSimPOLoss(
        beta=beta,
        gamma=gamma,
        unmasked_token_weight=unmasked_token_weight,
        sft_weight=sft_weight,
    )

    device = next(model.parameters()).device
    model.train()

    trainable_params = [p for p in model.parameters() if p.requires_grad]
    if not trainable_params:
        raise ValueError("Model has zero trainable parameters; attach or enable LoRA adapters first.")

    try:
        import bitsandbytes as bnb  # type: ignore[import-not-found]

        optimizer: Any = bnb.optim.AdamW8bit(
            trainable_params, lr=learning_rate, weight_decay=weight_decay
        )
    except Exception:
        optimizer = torch.optim.AdamW(
            trainable_params, lr=learning_rate, weight_decay=weight_decay
        )

    num_batches_per_epoch = max(1, math.ceil(len(pairs) / per_device_batch_size))
    total_opt_steps = (
        max_steps
        if max_steps > 0
        else max(
            1,
            int(
                math.ceil(
                    (num_batches_per_epoch * num_train_epochs)
                    / gradient_accumulation_steps
                )
            ),
        )
    )
    warmup_steps = max(1, int(total_opt_steps * warmup_ratio))

    def _lr_lambda(current_step: int) -> float:
        if current_step < warmup_steps:
            return float(current_step + 1) / float(max(1, warmup_steps))
        progress = float(current_step - warmup_steps) / float(
            max(1, total_opt_steps - warmup_steps)
        )
        return max(0.05, 0.5 * (1.0 + math.cos(math.pi * min(1.0, progress))))

    scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, _lr_lambda)

    t0 = time.perf_counter()
    optimizer.zero_grad()

    step = 0
    micro_step = 0
    total_epochs_ceil = max(1, int(math.ceil(num_train_epochs)))
    max_micro_steps = int(num_batches_per_epoch * num_train_epochs)
    history: list[dict[str, float]] = []

    for epoch in range(total_epochs_ceil):
        for start_idx in range(0, len(pairs), per_device_batch_size):
            if micro_step >= max_micro_steps or (0 < max_steps <= step):
                break
            batch_rows = pairs[start_idx : start_idx + per_device_batch_size]
            batch = collator(batch_rows)
            micro_step += 1

            c_input = batch["chosen_input_ids"].to(device)
            c_attn = batch["chosen_attention_mask"].to(device)
            c_labels = batch["chosen_labels"].to(device)
            c_mask = batch["chosen_token_mask"].to(device)

            r_input = batch["rejected_input_ids"].to(device)
            r_attn = batch["rejected_attention_mask"].to(device)
            r_labels = batch["rejected_labels"].to(device)
            r_mask = batch["rejected_token_mask"].to(device)

            c_out = model(input_ids=c_input, attention_mask=c_attn)
            r_out = model(input_ids=r_input, attention_mask=r_attn)

            loss_out = loss_fn(
                chosen_logits=c_out.logits.float(),
                chosen_labels=c_labels,
                rejected_logits=r_out.logits.float(),
                rejected_labels=r_labels,
                rejected_token_mask=r_mask,
                chosen_token_mask=c_mask,
            )

            scaled_loss = loss_out.loss / gradient_accumulation_steps
            scaled_loss.backward()

            if (
                micro_step % gradient_accumulation_steps == 0
                or micro_step == max_micro_steps
            ):
                torch.nn.utils.clip_grad_norm_(trainable_params, max_norm=1.0)
                optimizer.step()
                scheduler.step()
                optimizer.zero_grad()
                step += 1

                metrics = loss_out.to_metrics()
                metrics["step"] = float(step)
                metrics["lr"] = float(optimizer.param_groups[0]["lr"])
                history.append(metrics)

                if logging_steps > 0 and (step % logging_steps == 0 or step == 1):
                    print(
                        f"[MaskedSimPO] step={step}/{total_opt_steps} "
                        f"loss={metrics['loss']:.4f} "
                        f"margin={metrics['reward_margin']:.4f} "
                        f"acc={metrics['accuracy']:.3f} "
                        f"lr={metrics['lr']:.2e}"
                    )

                if 0 < max_steps <= step:
                    break

    elapsed = time.perf_counter() - t0
    final_m = history[-1] if history else {"loss": 0.0, "reward_margin": 0.0, "accuracy": 0.0}
    mean_loss = sum(h["loss"] for h in history) / max(1, len(history))

    return AlignmentSummary(
        steps_completed=step,
        epochs_completed=total_epochs_ceil,
        final_loss=round(float(final_m["loss"]), 6),
        mean_loss=round(float(mean_loss), 6),
        final_reward_margin=round(float(final_m["reward_margin"]), 6),
        final_accuracy=round(float(final_m["accuracy"]), 4),
        wall_time_sec=round(elapsed, 2),
        history=history,
    )
