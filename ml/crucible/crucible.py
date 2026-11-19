"""The 6-Gate Data Crucible for Lexel SFT and Preference Alignment datasets.

Ported from `/home/lawand/Prose/scripts/data_crucible.py` and `/home/lawand/Prose/src/wlab/validate_strict.py`:
1. `ZeroSlopGate`: 0 hits from `rules/slop_terms.json` + zero em dashes (`U+2014`) or spaced double hyphens (` -- `) outside code spans/blockquotes.
2. `NumericAndTokenGroundingGate`: 100% unit-bound numeric & code/URL/CLI-flag token preservation between `<source>` and target (`0` dropped, `0` invented).
3. `SurfaceComplianceGate`: Enforces `ml/personas/surfaces.json` rules for the example's `surface_id`.
4. `ActiveVerbAndDirectnessGate`: Active Verb Ratio (`AVR >= 0.85` on prose) + zero chatbot throat-clearing openers (`"Sure, here is..."`, `"Certainly!"`) or `<think>` tags.
5. `LexicalDensityAndBurstinessGate`: Sliding-window `MATTR-50` type-token ratio and sentence length standard deviation (`sigma_len`), computing `craft_score` (`S_craft`).
6. `IntegrityAndLeakageGate`: Syntactic completeness (balanced backticks, clean terminal punctuation), exact SHA-256 deduplication, 5-gram Jaccard near-duplicate check (`< 0.85`), and 8-gram train/heldout leakage check (`< 0.30` containment).
"""

from __future__ import annotations

import hashlib
import math
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Sequence

from ml.crucible.config import (
    PREACHY_CONCLUSION_PATTERNS,
    THROAT_CLEARING_PATTERNS,
    load_surface_catalog,
)
from ml.crucible.verifier import (
    extract_code_and_url_tokens,
    extract_unit_bound_metrics,
    scan_slop_terms,
    validate_surface_compliance,
)

WORD_TOKEN_PATTERN = re.compile(r"\b[A-Za-z0-9_]+(?:'[A-Za-z0-9_]+)?\b")
THINK_TAG_RE = re.compile(r"(?is)<think>.*?</think>|<think>|</think>")

PAST_PARTICIPLES: frozenset[str] = frozenset(
    {
        "been",
        "broken",
        "built",
        "bought",
        "caught",
        "chosen",
        "done",
        "drawn",
        "driven",
        "eaten",
        "fallen",
        "felt",
        "found",
        "given",
        "gone",
        "grown",
        "held",
        "hidden",
        "kept",
        "known",
        "laid",
        "led",
        "left",
        "lost",
        "made",
        "meant",
        "met",
        "paid",
        "read",
        "run",
        "said",
        "seen",
        "sent",
        "set",
        "shown",
        "shut",
        "spoken",
        "spent",
        "stood",
        "taken",
        "taught",
        "told",
        "thought",
        "understood",
        "worn",
        "won",
        "written",
        "witnessed",
        "reached",
        "caused",
        "observed",
        "initiated",
        "executed",
        "migrated",
        "restored",
        "diverted",
        "configured",
        "deployed",
        "discovered",
        "affected",
        "impacted",
        "experienced",
        "delayed",
        "degraded",
        "remediated",
        "resolved",
        "terminated",
    }
)

BE_AUXILIARIES: frozenset[str] = frozenset(
    {
        "is",
        "am",
        "are",
        "was",
        "were",
        "be",
        "being",
        "been",
        "gets",
        "get",
        "getting",
        "got",
        "gotten",
    }
)


def extract_words(text: str) -> list[str]:
    """Extract lowercased word tokens ignoring punctuation."""
    return [w.lower() for w in WORD_TOKEN_PATTERN.findall(text)]


def extract_sentences(text: str) -> list[str]:
    """Segment text into sentences with abbreviation and decimal handling."""
    cleaned = text.strip()
    if not cleaned:
        return []
    cleaned = re.sub(r"\b([A-Za-z])\.([A-Za-z])\.", r"\1_DOT_\2_DOT_", cleaned)
    cleaned = re.sub(r"\b([0-9]+)\.([0-9]+)\b", r"\1_DOT_\2", cleaned)
    cleaned = re.sub(
        r"\bv([0-9]+)\.([0-9]+)\.([0-9]+)\b", r"v\1_DOT_\2_DOT_\3", cleaned
    )
    cleaned = re.sub(
        r"\b(e\.g\.|i\.e\.|vs\.|etc\.|U\.S\.|Jan\.|Feb\.|Mar\.|Apr\.|Oct\.|Nov\.|Dec\.)",
        lambda m: m.group(1).replace(".", "_DOT_"),
        cleaned,
    )

    raw_sentences = re.split(r"(?<=[.!?])\s+|\n\n+", cleaned)
    sentences: list[str] = []
    for s in raw_sentences:
        unmasked = s.replace("_DOT_", ".").strip()
        if unmasked:
            sentences.append(unmasked)
    return sentences


def extract_shingles(text: str, k: int = 5) -> set[tuple[str, ...]]:
    """Extract k-gram word shingles for near-duplicate and leakage detection."""
    words = re.findall(r"\w+", text.lower())
    if not words:
        return set()
    if len(words) < k:
        return {tuple(words)}
    return {tuple(words[i : i + k]) for i in range(len(words) - k + 1)}


def jaccard_similarity(s1: set[tuple[str, ...]], s2: set[tuple[str, ...]]) -> float:
    """Compute Jaccard similarity between two shingle sets."""
    if not s1 or not s2:
        return 0.0
    return len(s1 & s2) / len(s1 | s2)


@dataclass
class GateResult:
    gate_name: str
    passed: bool
    score: float
    threshold: float
    details: dict[str, Any] = field(default_factory=dict)
    violations: list[str] = field(default_factory=list)


class ZeroSlopGate:
    """Gate 1: Zero hits from `rules/slop_terms.json` and zero em dashes (`U+2014` or ` -- `) outside code spans."""

    def __init__(self, include_extended: bool = False) -> None:
        self.include_extended = include_extended

    def evaluate(
        self, text: str, surface_id: str = "general"
    ) -> GateResult:
        catalog = load_surface_catalog()
        profile = catalog.get(surface_id)
        hits = scan_slop_terms(
            text,
            allow_em_dashes=profile.allow_em_dashes,
            include_extended=self.include_extended,
        )
        violations: list[str] = []
        banned_found: list[str] = []
        em_dash_count = 0

        for h in hits:
            if h["is_em_dash"]:
                em_dash_count += 1
                violations.append("Contains forbidden em dash or spaced double hyphen")
            else:
                term_lower = str(h["term"]).lower()
                banned_found.append(term_lower)
                violations.append(f"Banned AI slop term: '{term_lower}'")

        passed = len(hits) == 0
        return GateResult(
            gate_name="Gate 1: ZeroSlopGate",
            passed=passed,
            score=float(len(hits)),
            threshold=0.0,
            details={
                "banned_terms_found": sorted(set(banned_found)),
                "em_dash_count": em_dash_count,
                "total_hits": len(hits),
            },
            violations=violations,
        )


class NumericAndTokenGroundingGate:
    """Gate 2: 100% unit-bound numeric & code/URL/CLI-flag token preservation between `<source>` and target (`0` dropped, `0` invented)."""

    def evaluate(self, target: str, source: str) -> GateResult:
        source_metrics = extract_unit_bound_metrics(source)
        target_metrics = extract_unit_bound_metrics(target)

        missing_metrics = [
            sm.raw
            for sm in source_metrics
            if not any(
                abs(tm.value - sm.value) < 1e-9 and tm.unit == sm.unit
                for tm in target_metrics
            )
        ]
        invented_metrics = [
            tm.raw
            for tm in target_metrics
            if not any(
                abs(sm.value - tm.value) < 1e-9 and sm.unit == tm.unit
                for sm in source_metrics
            )
        ]

        source_tokens = extract_code_and_url_tokens(source)
        missing_tokens = [tok for tok in source_tokens if tok not in target]

        violations: list[str] = []
        if missing_metrics:
            violations.append(
                f"Dropped/altered source metrics: {', '.join(missing_metrics)}"
            )
        if invented_metrics:
            violations.append(
                f"Invented/hallucinated target metrics: {', '.join(invented_metrics)}"
            )
        if missing_tokens:
            violations.append(
                f"Dropped code/URL/CLI tokens: {', '.join(missing_tokens)}"
            )

        total_issues = (
            len(missing_metrics) + len(invented_metrics) + len(missing_tokens)
        )
        passed = total_issues == 0

        return GateResult(
            gate_name="Gate 2: NumericAndTokenGroundingGate",
            passed=passed,
            score=1.0 if passed else 0.0,
            threshold=1.0,
            details={
                "source_metrics": [m.raw for m in source_metrics],
                "target_metrics": [m.raw for m in target_metrics],
                "missing_metrics": missing_metrics,
                "invented_metrics": invented_metrics,
                "source_tokens": source_tokens,
                "missing_tokens": missing_tokens,
            },
            violations=violations,
        )


class SurfaceComplianceGate:
    """Gate 3: Enforces `ml/personas/surfaces.json` rules for the example's `surface_id`."""

    def evaluate(self, text: str, surface_id: str = "general") -> GateResult:
        violations_objs = validate_surface_compliance(
            text, surface_id=surface_id, enforce_min_chars=True
        )
        violations = [f"[{v.kind}] {v.message}" for v in violations_objs]
        passed = len(violations) == 0
        return GateResult(
            gate_name="Gate 3: SurfaceComplianceGate",
            passed=passed,
            score=1.0 if passed else 0.0,
            threshold=1.0,
            details={
                "surface_id": surface_id,
                "char_count": len(text),
                "violation_kinds": [v.kind for v in violations_objs],
            },
            violations=violations,
        )


class ActiveVerbAndDirectnessGate:
    """Gate 4: Active Verb Ratio (`AVR >= 0.85` on prose) + zero chatbot throat-clearing openers or `<think>` tags."""

    def __init__(self, avr_threshold: float = 0.85) -> None:
        self.avr_threshold = avr_threshold

    def evaluate(self, text: str, surface_id: str = "general") -> GateResult:
        words = extract_words(text)
        if not words:
            return GateResult(
                gate_name="Gate 4: ActiveVerbAndDirectnessGate",
                passed=False,
                score=0.0,
                threshold=self.avr_threshold,
                details={"active_verb_ratio": 0.0},
                violations=["Empty text provided"],
            )

        violations: list[str] = []
        if THINK_TAG_RE.search(text):
            violations.append("Contains forbidden <think> reasoning tag")

        stripped = text.strip()
        sentences = extract_sentences(stripped)
        first_sentence = sentences[0] if sentences else stripped
        for pat in THROAT_CLEARING_PATTERNS:
            if pat.search(stripped) or pat.search(first_sentence):
                violations.append(
                    f"Contains chatbot throat-clearing opener matching {pat.pattern!r}"
                )
                break

        last_sentence = sentences[-1] if sentences else stripped
        for pat in PREACHY_CONCLUSION_PATTERNS:
            if pat.search(last_sentence):
                violations.append(
                    f"Contains preachy AI conclusion matching {pat.pattern!r}"
                )
                break

        passive_matches: list[str] = []
        for i in range(len(words) - 1):
            w = words[i]
            if w in BE_AUXILIARIES:
                for offset in (1, 2):
                    if i + offset < len(words):
                        next_word = words[i + offset]
                        if (
                            next_word in PAST_PARTICIPLES
                            or (next_word.endswith("ed") and len(next_word) > 4)
                            or (next_word.endswith("en") and len(next_word) > 4)
                        ):
                            passive_matches.append(
                                " ".join(words[i : i + offset + 1])
                            )
                            break

        num_sentences = max(1, len(sentences))
        # Estimate total verb phrases scaling with sentence and clause count
        clause_count = max(num_sentences, len(words) // 10)
        estimated_active_verbs = max(
            1, clause_count * 2 - len(passive_matches)
        )
        total_verbs = estimated_active_verbs + len(passive_matches)
        avr = estimated_active_verbs / total_verbs if total_verbs > 0 else 1.0

        if avr < self.avr_threshold:
            violations.append(
                f"Active Verb Ratio {avr * 100:.1f}% < {self.avr_threshold * 100:.1f}% (passives: {passive_matches})"
            )

        passed = len(violations) == 0
        return GateResult(
            gate_name="Gate 4: ActiveVerbAndDirectnessGate",
            passed=passed,
            score=round(avr, 4),
            threshold=self.avr_threshold,
            details={
                "active_verb_ratio": round(avr, 4),
                "passive_phrases": passive_matches,
                "passive_count": len(passive_matches),
                "surface_id": surface_id,
            },
            violations=violations,
        )


class LexicalDensityAndBurstinessGate:
    """Gate 5: Sliding-window `MATTR-50` type-token ratio and sentence length standard deviation (`sigma_len`), computing `craft_score` (`S_craft`)."""

    def __init__(
        self,
        window_size: int = 50,
        mattr_threshold: float = 0.65,
        burstiness_threshold: float = 2.0,
    ) -> None:
        self.window_size = window_size
        self.mattr_threshold = mattr_threshold
        self.burstiness_threshold = burstiness_threshold

    def evaluate(self, text: str, avr: float = 1.0) -> GateResult:
        words = extract_words(text)
        n = len(words)
        if n == 0:
            return GateResult(
                gate_name="Gate 5: LexicalDensityAndBurstinessGate",
                passed=False,
                score=0.0,
                threshold=self.mattr_threshold,
                details={"mattr_50": 0.0, "sigma_len": 0.0, "craft_score": 0.0},
                violations=["Empty text provided"],
            )

        if n < self.window_size:
            mattr = len(set(words)) / n
        else:
            counts = Counter(words[: self.window_size])
            distinct_sum = len(counts)
            for i in range(self.window_size, n):
                outgoing = words[i - self.window_size]
                incoming = words[i]
                counts[outgoing] -= 1
                if counts[outgoing] == 0:
                    del counts[outgoing]
                counts[incoming] += 1
                distinct_sum += len(counts)
            num_windows = n - self.window_size + 1
            mattr = distinct_sum / (num_windows * self.window_size)

        sentences = extract_sentences(text)
        lengths = [len(extract_words(s)) for s in sentences if extract_words(s)]
        m = len(lengths)
        if m <= 1:
            sigma = 0.0
            burstiness_ok = True
        elif m == 2:
            sigma = float(abs(lengths[0] - lengths[1])) / 2.0
            burstiness_ok = True
        else:
            mean_len = sum(lengths) / m
            variance = sum((length - mean_len) ** 2 for length in lengths) / m
            sigma = math.sqrt(variance)
            burstiness_ok = sigma >= self.burstiness_threshold or n < 35

        mattr_ok = mattr >= self.mattr_threshold
        violations: list[str] = []
        if not mattr_ok:
            violations.append(
                f"MATTR-50 score {mattr:.4f} below threshold {self.mattr_threshold:.2f}"
            )
        if not burstiness_ok:
            violations.append(
                f"Sentence burstiness sigma_len {sigma:.2f} below threshold {self.burstiness_threshold:.2f}"
            )

        passed = mattr_ok and burstiness_ok
        sigma_norm = min(sigma / 15.0, 1.0) if m >= 2 else 0.5
        craft_score = (
            0.40 * mattr
            + 0.25 * sigma_norm
            + 0.20 * avr
            + 0.15 * (1.0 if passed else 0.0)
        )

        return GateResult(
            gate_name="Gate 5: LexicalDensityAndBurstinessGate",
            passed=passed,
            score=round(mattr, 4),
            threshold=self.mattr_threshold,
            details={
                "mattr_50": round(mattr, 4),
                "sigma_len": round(sigma, 4),
                "sentence_count": m,
                "sentence_lengths": lengths,
                "total_words": n,
                "craft_score": round(craft_score, 4),
            },
            violations=violations,
        )


class IntegrityAndLeakageGate:
    """Gate 6: Syntactic completeness, exact SHA-256 deduplication, 5-gram Jaccard near-duplicate check (< 0.85), and 8-gram train/heldout leakage check (< 0.30)."""

    def __init__(
        self,
        near_dup_threshold: float = 0.85,
        leakage_threshold: float = 0.30,
    ) -> None:
        self.near_dup_threshold = near_dup_threshold
        self.leakage_threshold = leakage_threshold
        self.seen_hashes: set[str] = set()
        self.seen_5grams: list[tuple[str, set[tuple[str, ...]]]] = []
        self.heldout_8grams: list[tuple[str, set[tuple[str, ...]]]] = []

    def reset_state(self) -> None:
        self.seen_hashes.clear()
        self.seen_5grams.clear()

    def register_heldout_corpus(
        self, heldout_texts: Sequence[tuple[str, str]]
    ) -> None:
        """Register held-out benchmark examples `(task_id, text)` for 8-gram leakage detection."""
        self.heldout_8grams = []
        for task_id, text in heldout_texts:
            shingles_8 = extract_shingles(text, k=8)
            if shingles_8:
                self.heldout_8grams.append((task_id, shingles_8))

    def evaluate(
        self,
        text: str,
        surface_id: str = "general",
        example_id: str = "sample",
        register_in_corpus: bool = False,
    ) -> GateResult:
        stripped = text.strip()
        violations: list[str] = []

        if not stripped:
            return GateResult(
                gate_name="Gate 6: IntegrityAndLeakageGate",
                passed=False,
                score=0.0,
                threshold=1.0,
                details={"sha256": ""},
                violations=["Empty text"],
            )

        # 1. Balanced fenced and inline backticks
        fence_count = stripped.count("```")
        if fence_count % 2 != 0:
            violations.append(
                "Unclosed markdown code fence (odd number of triple backticks)"
            )
        without_fences = re.sub(r"```[\s\S]*?```", "", stripped)
        if without_fences.count("`") % 2 != 0:
            violations.append(
                "Unbalanced inline backticks outside fenced code blocks"
            )

        # 2. Terminal punctuation check (except git commit subjects & chat/code snippets)
        if surface_id not in ("ide_git_commit", "web_discord_slack", "ide_code_comment"):
            if stripped[-1] not in ".!?\"'”’`*)];":
                violations.append(
                    f"Response ends abruptly without terminal punctuation: {stripped[-20:]!r}"
                )

        # 3. Exact SHA-256 deduplication
        sha256_hex = hashlib.sha256(stripped.encode("utf-8")).hexdigest()
        is_exact_dup = sha256_hex in self.seen_hashes
        if is_exact_dup:
            violations.append(f"Exact SHA-256 duplicate detected ({sha256_hex[:12]})")

        # 4. 5-gram Jaccard near-duplicate check (< 0.85)
        shingles_5 = extract_shingles(stripped, k=5)
        max_jaccard = 0.0
        nearest_id = None
        if len(extract_words(stripped)) >= 8:
            for prev_id, prev_5 in self.seen_5grams:
                sim = jaccard_similarity(shingles_5, prev_5)
                if sim > max_jaccard:
                    max_jaccard = sim
                    nearest_id = prev_id
                if sim >= self.near_dup_threshold:
                    violations.append(
                        f"5-gram near-duplicate ({sim:.2f} >= {self.near_dup_threshold}) with {prev_id}"
                    )
                    break

        # 5. 8-gram train/heldout leakage check (< 0.30 containment)
        shingles_8 = extract_shingles(stripped, k=8)
        max_containment = 0.0
        leaked_task_id = None
        for h_id, h_8 in self.heldout_8grams:
            if not h_8:
                continue
            containment = len(shingles_8 & h_8) / len(h_8)
            if containment > max_containment:
                max_containment = containment
                leaked_task_id = h_id
            if containment >= self.leakage_threshold:
                violations.append(
                    f"8-gram held-out leakage ({containment:.2f} >= {self.leakage_threshold}) against {h_id}"
                )
                break

        if register_in_corpus and not violations:
            self.seen_hashes.add(sha256_hex)
            if shingles_5:
                self.seen_5grams.append((example_id, shingles_5))

        passed = len(violations) == 0
        return GateResult(
            gate_name="Gate 6: IntegrityAndLeakageGate",
            passed=passed,
            score=1.0 if passed else 0.0,
            threshold=1.0,
            details={
                "sha256": sha256_hex,
                "is_exact_duplicate": is_exact_dup,
                "max_5gram_jaccard": round(max_jaccard, 4),
                "nearest_example_id": nearest_id,
                "max_8gram_containment": round(max_containment, 4),
                "leaked_heldout_id": leaked_task_id,
            },
            violations=violations,
        )


@dataclass
class CrucibleAuditResult:
    example_id: str
    surface_id: str
    passed_all: bool
    gate_results: dict[str, GateResult]
    violations: list[str]
    craft_score: float


class DataCrucible:
    """Unified 6-Gate Lexel Data Crucible."""

    def __init__(
        self,
        include_extended_slop: bool = False,
        avr_threshold: float = 0.85,
        mattr_threshold: float = 0.65,
        burstiness_threshold: float = 2.0,
        near_dup_threshold: float = 0.85,
        leakage_threshold: float = 0.30,
    ) -> None:
        self.gate1_slop = ZeroSlopGate(include_extended=include_extended_slop)
        self.gate2_grounding = NumericAndTokenGroundingGate()
        self.gate3_surface = SurfaceComplianceGate()
        self.gate4_directness = ActiveVerbAndDirectnessGate(
            avr_threshold=avr_threshold
        )
        self.gate5_lexical = LexicalDensityAndBurstinessGate(
            mattr_threshold=mattr_threshold,
            burstiness_threshold=burstiness_threshold,
        )
        self.gate6_integrity = IntegrityAndLeakageGate(
            near_dup_threshold=near_dup_threshold,
            leakage_threshold=leakage_threshold,
        )

    def reset_corpus_state(self) -> None:
        self.gate6_integrity.reset_state()

    def register_heldout_corpus(
        self, heldout_texts: Sequence[tuple[str, str]]
    ) -> None:
        self.gate6_integrity.register_heldout_corpus(heldout_texts)

    def audit_sample(
        self,
        target: str,
        source: str,
        surface_id: str = "general",
        example_id: str = "sample_001",
        register_in_corpus: bool = False,
    ) -> CrucibleAuditResult:
        """Evaluate a `(source, target, surface_id)` example across all 6 Crucible gates."""
        g1 = self.gate1_slop.evaluate(target, surface_id=surface_id)
        g2 = self.gate2_grounding.evaluate(target=target, source=source)
        g3 = self.gate3_surface.evaluate(target, surface_id=surface_id)
        g4 = self.gate4_directness.evaluate(target, surface_id=surface_id)
        g5 = self.gate5_lexical.evaluate(target, avr=g4.score)
        g6 = self.gate6_integrity.evaluate(
            target,
            surface_id=surface_id,
            example_id=example_id,
            register_in_corpus=register_in_corpus,
        )

        gate_results = {
            "gate1_zero_slop": g1,
            "gate2_numeric_and_token_grounding": g2,
            "gate3_surface_compliance": g3,
            "gate4_active_verb_and_directness": g4,
            "gate5_lexical_density_and_burstiness": g5,
            "gate6_integrity_and_leakage": g6,
        }

        all_violations: list[str] = []
        for g in gate_results.values():
            all_violations.extend(g.violations)

        passed_all = all(g.passed for g in gate_results.values())
        mattr = float(g5.details.get("mattr_50", 0.0))
        sigma = float(g5.details.get("sigma_len", 0.0))
        sigma_norm = (
            min(sigma / 15.0, 1.0)
            if int(g5.details.get("sentence_count", 1)) >= 2
            else 0.5
        )
        craft_score = (
            0.40 * mattr
            + 0.25 * sigma_norm
            + 0.20 * g4.score
            + 0.15 * (1.0 if passed_all else 0.0)
        )

        return CrucibleAuditResult(
            example_id=example_id,
            surface_id=surface_id,
            passed_all=passed_all,
            gate_results=gate_results,
            violations=all_violations,
            craft_score=round(craft_score, 4),
        )
