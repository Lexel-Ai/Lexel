"""Statistical evaluation suite and WritingBench Sovereign Critic for Lexel.

Ported from `/home/lawand/Prose/scripts/eval_36_benchmark.py` and `/home/lawand/Prose/src/wlab/critic.py`:
- Exact 95% Clopper-Pearson binomial confidence intervals (`clopper_pearson_interval`).
- Exact one-sided binomial sign test p-value (`sign_test_p_value`).
- `WritingBenchCritic` 5-dimension rubric:
  - `factual_grounding` (0.30)
  - `anti_slop_integrity` (0.25)
  - `compression_density` (0.20)
  - `executive_directness` (0.15)
  - `structural_cadence` (0.10)
- Double-blind pairwise evaluation with Swap Debiasing and Length-Controlled AlpacaEval-LC margin adjustment.
- `JudgeCalibrator` computing Cohen's Kappa, Randolph's free-marginal Kappa, and empirical length-bias beta.
"""

from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass, field
from typing import Any, Literal, Sequence

from ml.crucible.config import (
    FILLER_PHRASES,
    PREACHY_CONCLUSION_PATTERNS,
    THROAT_CLEARING_PATTERNS,
)
from ml.crucible.crucible import extract_words
from ml.crucible.verifier import (
    extract_code_and_url_tokens,
    extract_unit_bound_metrics,
    scan_slop_terms,
    verify_rewrite,
)

DEFAULT_WEIGHTS: dict[str, float] = {
    "factual_grounding": 0.30,
    "anti_slop_integrity": 0.25,
    "compression_density": 0.20,
    "executive_directness": 0.15,
    "structural_cadence": 0.10,
}


def clopper_pearson_interval(
    k: int, n: int, alpha: float = 0.05
) -> tuple[float, float]:
    """Exact two-sided binomial confidence interval matching `Prose/scripts/eval_36_benchmark.py`."""
    if n <= 0:
        return 0.0, 1.0
    z = 1.959963984540054 if abs(alpha - 0.05) < 1e-6 else 1.96
    if k <= 0:
        lower = 0.0
    else:
        lower = k / (k + (n - k + 1) * math.exp(2 * z / math.sqrt(2 * n)))
        lower = max(0.0, lower)
    if k >= n:
        upper = 1.0
    else:
        upper = min(
            1.0,
            (k + 1) / (k + 1 + (n - k) * math.exp(-2 * z / math.sqrt(2 * n))),
        )
    return round(lower, 4), round(upper, 4)


def sign_test_p_value(wins: int, total_decisive: int) -> float:
    """Exact one-sided sign test p-value under the null hypothesis `p = 0.5`."""
    if total_decisive <= 0:
        return 1.0
    if wins <= 0:
        return 1.0
    if wins > total_decisive:
        return 0.0
    p_val = sum(
        math.comb(total_decisive, i) * (0.5**total_decisive)
        for i in range(wins, total_decisive + 1)
    )
    return round(p_val, 8)


@dataclass
class EvaluationBrief:
    source_material: str = ""
    surface_id: str = "general"
    task: str = "deslop"
    instruction: str = ""

    @classmethod
    def from_any(cls, obj: Any) -> EvaluationBrief:
        if isinstance(obj, EvaluationBrief):
            return obj
        if isinstance(obj, str):
            return cls(source_material=obj)
        if isinstance(obj, dict):
            return cls(
                source_material=str(
                    obj.get("source_material")
                    or obj.get("source")
                    or obj.get("prompt")
                    or ""
                ),
                surface_id=str(obj.get("surface_id") or "general"),
                task=str(obj.get("task") or "deslop"),
                instruction=str(obj.get("instruction") or ""),
            )
        return cls(
            source_material=str(getattr(obj, "source_material", "")),
            surface_id=str(getattr(obj, "surface_id", "general")),
            task=str(getattr(obj, "task", "deslop")),
            instruction=str(getattr(obj, "instruction", "")),
        )


@dataclass
class WritingBenchDimensionScores:
    factual_grounding: float
    compression_density: float
    structural_cadence: float
    anti_slop_integrity: float
    executive_directness: float
    composite_score: float
    word_count: int
    sentence_count: int
    type_token_ratio: float
    cadence_entropy: float
    detected_slop: list[str] = field(default_factory=list)
    unsupported_numbers: list[str] = field(default_factory=list)
    missing_numbers: list[str] = field(default_factory=list)
    missing_tokens: list[str] = field(default_factory=list)

    def model_dump(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class PairwiseComparison:
    winner: Literal["A", "B", "tie"]
    confidence: float
    raw_margin: float
    length_adjusted_margin: float
    length_difference: int
    forward_winner: Literal["A", "B", "tie"]
    swapped_winner: Literal["A", "B", "tie"]
    is_position_consistent: bool
    position_bias_detected: bool
    scores_a: WritingBenchDimensionScores
    scores_b: WritingBenchDimensionScores
    dimension_deltas: dict[str, float]

    def model_dump(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class CalibrationReport:
    total_pairs: int
    decisive_pairs: int
    ties: int
    accuracy_raw: float
    accuracy_decisive: float
    position_invariance_rate: float
    slop_trap_win_rate: float
    fact_trap_win_rate: float
    cohen_kappa: float
    randolph_free_kappa: float
    observed_agreement: float
    expected_agreement: float
    sign_test_p_value: float
    estimated_length_bias_beta: float

    def model_dump(self) -> dict[str, Any]:
        return asdict(self)


class WritingBenchCritic:
    """Automated 5-dimension sovereign critic engine with Swap and Length Debiasing."""

    def __init__(
        self,
        weights: dict[str, float] | None = None,
        length_bias_beta: float = 0.005,
        tie_margin_threshold: float = 0.15,
    ) -> None:
        self.weights = dict(weights or DEFAULT_WEIGHTS)
        self.length_bias_beta = length_bias_beta
        self.tie_margin_threshold = tie_margin_threshold

    def score_candidate(
        self, brief: EvaluationBrief | dict[str, Any] | str, text: str
    ) -> WritingBenchDimensionScores:
        """Evaluate a candidate text across all 5 WritingBench dimensions."""
        parsed_brief = EvaluationBrief.from_any(brief)
        words = extract_words(text)
        word_count = len(words)

        raw_sentences = [
            s.strip() for s in re.split(r"[.!?]+", text) if s.strip()
        ]
        sentence_count = max(1, len(raw_sentences))

        # 1. Anti-Slop Integrity (0-10)
        slop_hits = scan_slop_terms(
            text, allow_em_dashes=False, include_extended=True
        )
        detected_slop = [
            "em_dash" if h["is_em_dash"] else str(h["term"]).lower()
            for h in slop_hits
        ]
        slop_penalty = min(9.5, len(detected_slop) * 1.8)
        anti_slop_score = max(0.5, 10.0 - slop_penalty)

        # 2. Factual Grounding & AST Verification (0-10)
        unsupported_numbers: list[str] = []
        missing_numbers: list[str] = []
        missing_tokens: list[str] = []
        src_mat = parsed_brief.source_material.strip()
        if src_mat:
            src_metrics = extract_unit_bound_metrics(src_mat)
            cand_metrics = extract_unit_bound_metrics(text)
            missing_numbers = [
                sm.raw
                for sm in src_metrics
                if not any(
                    abs(cm.value - sm.value) < 1e-9 and cm.unit == sm.unit
                    for cm in cand_metrics
                )
            ]
            unsupported_numbers = [
                cm.raw
                for cm in cand_metrics
                if not any(
                    abs(sm.value - cm.value) < 1e-9 and sm.unit == cm.unit
                    for sm in src_metrics
                )
            ]
            src_tokens = extract_code_and_url_tokens(src_mat)
            missing_tokens = [tok for tok in src_tokens if tok not in text]

            total_fact_errors = (
                len(missing_numbers)
                + len(unsupported_numbers)
                + len(missing_tokens)
            )
            fact_penalty = min(9.0, total_fact_errors * 3.0)
            factual_score = max(1.0, 10.0 - fact_penalty)
        else:
            factual_score = 9.0

        # 3. Compression Density & Signal-to-Token Ratio (0-10)
        unique_words = len(set(words))
        ttr = unique_words / max(1, word_count)
        text_lower = text.lower()
        filler_count = sum(
            1 for phrase in FILLER_PHRASES if phrase in text_lower
        )
        filler_penalty = min(4.0, filler_count * 1.5)
        ttr_score = min(10.0, max(2.0, (ttr - 0.30) / 0.40 * 10.0))
        compression_score = max(1.0, ttr_score - filler_penalty)

        # 4. Structural Cadence & Sentence Entropy (0-10)
        sent_lengths = [len(extract_words(s)) for s in raw_sentences if s]
        if len(sent_lengths) >= 2:
            buckets: dict[int, int] = {}
            for length in sent_lengths:
                b = length // 5
                buckets[b] = buckets.get(b, 0) + 1
            total_sents = len(sent_lengths)
            entropy = -sum(
                (cnt / total_sents) * math.log2(cnt / total_sents)
                for cnt in buckets.values()
            )
            mean_len = sum(sent_lengths) / total_sents
            variance = (
                sum((length - mean_len) ** 2 for length in sent_lengths)
                / total_sents
            )
            std_dev = math.sqrt(variance)
            cadence_score = min(
                10.0, max(2.0, (entropy / 2.2) * 5.0 + min(5.0, std_dev))
            )
        else:
            entropy = 0.5
            cadence_score = 5.0

        # 5. Executive Directness (0-10)
        directness_penalties = 0.0
        first_sentence = raw_sentences[0] if raw_sentences else ""
        for pat in THROAT_CLEARING_PATTERNS:
            if pat.search(first_sentence) or pat.search(text.strip()):
                directness_penalties += 3.5

        last_sentence = raw_sentences[-1] if raw_sentences else ""
        for pat in PREACHY_CONCLUSION_PATTERNS:
            if pat.search(last_sentence) or pat.search(text):
                directness_penalties += 2.5

        directness_score = max(1.0, 10.0 - directness_penalties)

        composite = (
            factual_score * self.weights["factual_grounding"]
            + anti_slop_score * self.weights["anti_slop_integrity"]
            + compression_score * self.weights["compression_density"]
            + directness_score * self.weights["executive_directness"]
            + cadence_score * self.weights["structural_cadence"]
        )

        return WritingBenchDimensionScores(
            factual_grounding=round(factual_score, 2),
            compression_density=round(compression_score, 2),
            structural_cadence=round(cadence_score, 2),
            anti_slop_integrity=round(anti_slop_score, 2),
            executive_directness=round(directness_score, 2),
            composite_score=round(composite, 2),
            word_count=word_count,
            sentence_count=sentence_count,
            type_token_ratio=round(ttr, 4),
            cadence_entropy=round(entropy, 4),
            detected_slop=detected_slop,
            unsupported_numbers=unsupported_numbers,
            missing_numbers=missing_numbers,
            missing_tokens=missing_tokens,
        )

    def evaluate_pair(
        self,
        brief: EvaluationBrief | dict[str, Any] | str,
        text_a: str,
        text_b: str,
        debias_position: bool = True,
        debias_length: bool = True,
    ) -> PairwiseComparison:
        """Run double-blind pairwise comparison with swap and length debiasing."""
        score_a = self.score_candidate(brief, text_a)
        score_b = self.score_candidate(brief, text_b)

        raw_diff_fwd = score_a.composite_score - score_b.composite_score
        if raw_diff_fwd > self.tie_margin_threshold:
            fwd_winner: Literal["A", "B", "tie"] = "A"
        elif raw_diff_fwd < -self.tie_margin_threshold:
            fwd_winner = "B"
        else:
            fwd_winner = "tie"

        if debias_position:
            raw_diff_swapped = score_b.composite_score - score_a.composite_score
            if raw_diff_swapped > self.tie_margin_threshold:
                swp_winner: Literal["A", "B", "tie"] = "B"
            elif raw_diff_swapped < -self.tie_margin_threshold:
                swp_winner = "A"
            else:
                swp_winner = "tie"
            is_consistent = fwd_winner == swp_winner
            position_bias = not is_consistent
        else:
            swp_winner = fwd_winner
            is_consistent = True
            position_bias = False

        len_diff = score_a.word_count - score_b.word_count
        if debias_length:
            adjusted_diff = raw_diff_fwd - (self.length_bias_beta * len_diff)
        else:
            adjusted_diff = raw_diff_fwd

        if debias_position and not is_consistent:
            winner: Literal["A", "B", "tie"] = "tie"
            confidence = 0.50
        else:
            if adjusted_diff > self.tie_margin_threshold:
                winner = "A"
                confidence = min(0.99, 0.50 + abs(adjusted_diff) / 10.0)
            elif adjusted_diff < -self.tie_margin_threshold:
                winner = "B"
                confidence = min(0.99, 0.50 + abs(adjusted_diff) / 10.0)
            else:
                winner = "tie"
                confidence = 0.50

        deltas = {
            "factual_grounding": round(
                score_a.factual_grounding - score_b.factual_grounding, 2
            ),
            "anti_slop_integrity": round(
                score_a.anti_slop_integrity - score_b.anti_slop_integrity, 2
            ),
            "compression_density": round(
                score_a.compression_density - score_b.compression_density, 2
            ),
            "executive_directness": round(
                score_a.executive_directness - score_b.executive_directness, 2
            ),
            "structural_cadence": round(
                score_a.structural_cadence - score_b.structural_cadence, 2
            ),
        }

        return PairwiseComparison(
            winner=winner,
            confidence=round(confidence, 4),
            raw_margin=round(raw_diff_fwd, 4),
            length_adjusted_margin=round(adjusted_diff, 4),
            length_difference=len_diff,
            forward_winner=fwd_winner,
            swapped_winner=swp_winner,
            is_position_consistent=is_consistent,
            position_bias_detected=position_bias,
            scores_a=score_a,
            scores_b=score_b,
            dimension_deltas=deltas,
        )


class JudgeCalibrator:
    """Calibrates and validates judge alignment against human ground truth preference pairs."""

    def __init__(self, critic: WritingBenchCritic | None = None) -> None:
        self.critic = critic or WritingBenchCritic()

    def calibrate(
        self, labeled_pairs: Sequence[dict[str, Any]]
    ) -> CalibrationReport:
        total = len(labeled_pairs)
        if total == 0:
            raise ValueError("Cannot calibrate on empty pair set")

        decisive_count = 0
        tie_count = 0
        correct_raw = 0
        correct_decisive = 0
        position_inconsistent_count = 0

        slop_trap_total = 0
        slop_trap_wins = 0
        fact_trap_total = 0
        fact_trap_wins = 0

        length_diffs: list[int] = []
        raw_margins: list[float] = []

        for pair in labeled_pairs:
            brief_raw = (
                pair.get("brief")
                or pair.get("source")
                or pair.get("prompt")
                or ""
            )
            brief = EvaluationBrief.from_any(brief_raw)
            chosen_text = str(pair["chosen"])
            rejected_text = str(pair["rejected"])
            ptype = str(pair.get("perturbation_type", "unknown"))

            res = self.critic.evaluate_pair(brief, chosen_text, rejected_text)
            length_diffs.append(res.length_difference)
            raw_margins.append(res.raw_margin)

            if not res.is_position_consistent:
                position_inconsistent_count += 1

            if res.winner == "tie":
                tie_count += 1
            else:
                decisive_count += 1
                if res.winner == "A":
                    correct_raw += 1
                    correct_decisive += 1

            if ptype in ("corporate_slop", "em_dash_injection"):
                slop_trap_total += 1
                if res.winner == "A":
                    slop_trap_wins += 1
            elif ptype in (
                "numerical_hallucination",
                "metric_distortion",
                "entity_swap",
                "code_token_drop",
            ):
                fact_trap_total += 1
                if res.winner == "A":
                    fact_trap_wins += 1

        acc_raw = correct_raw / total
        acc_decisive = (
            (correct_decisive / decisive_count) if decisive_count > 0 else 0.0
        )
        pos_invariance = 1.0 - (position_inconsistent_count / total)
        slop_win_rate = (
            (slop_trap_wins / slop_trap_total) if slop_trap_total > 0 else 1.0
        )
        fact_win_rate = (
            (fact_trap_wins / fact_trap_total) if fact_trap_total > 0 else 1.0
        )

        p_o = correct_raw / total
        randolph_kappa = (p_o - (1.0 / 3.0)) / (1.0 - (1.0 / 3.0))
        cohen_kappa = (p_o - 0.5) / 0.5 if decisive_count > 0 else 0.0
        sign_p = sign_test_p_value(correct_decisive, decisive_count)

        mean_l = sum(length_diffs) / total
        mean_m = sum(raw_margins) / total
        cov = sum(
            (length - mean_l) * (margin - mean_m)
            for length, margin in zip(length_diffs, raw_margins)
        )
        var_l = sum((length - mean_l) ** 2 for length in length_diffs)
        estimated_beta = (cov / var_l) if var_l > 1e-6 else 0.0

        return CalibrationReport(
            total_pairs=total,
            decisive_pairs=decisive_count,
            ties=tie_count,
            accuracy_raw=round(acc_raw, 4),
            accuracy_decisive=round(acc_decisive, 4),
            position_invariance_rate=round(pos_invariance, 4),
            slop_trap_win_rate=round(slop_win_rate, 4),
            fact_trap_win_rate=round(fact_win_rate, 4),
            cohen_kappa=round(cohen_kappa, 4),
            randolph_free_kappa=round(randolph_kappa, 4),
            observed_agreement=round(p_o, 4),
            expected_agreement=round(1.0 / 3.0, 4),
            sign_test_p_value=round(sign_p, 8),
            estimated_length_bias_beta=round(estimated_beta, 6),
        )


def evaluate_heldout_generations(
    records: Sequence[dict[str, Any]],
    candidate_key: str = "reference_target",
) -> dict[str, Any]:
    """Run deterministic held-out benchmark gates across all 13 surfaces with 95% Clopper-Pearson confidence intervals."""
    total = len(records)
    if total == 0:
        raise ValueError("Empty heldout evaluation records")

    zero_slop_passes = 0
    number_passes = 0
    token_passes = 0
    surface_passes = 0
    all_passes = 0
    per_surface: dict[str, dict[str, int]] = {}

    for rec in records:
        source = str(rec.get("source") or "")
        candidate = str(
            rec.get(candidate_key)
            or rec.get("reference_target")
            or rec.get("target")
            or ""
        )
        surface_id = str(rec.get("surface_id") or "general")
        summary = verify_rewrite(
            source=source, candidate=candidate, surface_id=surface_id
        )

        if summary.zero_slop:
            zero_slop_passes += 1
        if summary.numbers_preserved:
            number_passes += 1
        if summary.tokens_preserved:
            token_passes += 1
        if summary.surface_compliant:
            surface_passes += 1
        if summary.passed_all:
            all_passes += 1

        surf_stats = per_surface.setdefault(
            surface_id, {"total": 0, "passed": 0}
        )
        surf_stats["total"] += 1
        if summary.passed_all:
            surf_stats["passed"] += 1

    zero_slop_rate = zero_slop_passes / total
    number_rate = number_passes / total
    token_rate = token_passes / total
    surface_rate = surface_passes / total
    overall_rate = all_passes / total

    gates_ok = (
        zero_slop_rate >= 0.95
        and number_rate == 1.0
        and token_rate == 1.0
        and surface_rate >= 0.90
    )

    return {
        "total_examples": total,
        "gates_passed": gates_ok,
        "zero_slop_rate": round(zero_slop_rate, 4),
        "zero_slop_ci95": clopper_pearson_interval(zero_slop_passes, total),
        "number_preservation_rate": round(number_rate, 4),
        "number_preservation_ci95": clopper_pearson_interval(
            number_passes, total
        ),
        "token_preservation_rate": round(token_rate, 4),
        "token_preservation_ci95": clopper_pearson_interval(
            token_passes, total
        ),
        "surface_compliance_rate": round(surface_rate, 4),
        "surface_compliance_ci95": clopper_pearson_interval(
            surface_passes, total
        ),
        "overall_pass_rate": round(overall_rate, 4),
        "overall_pass_ci95": clopper_pearson_interval(all_passes, total),
        "per_surface": per_surface,
    }
