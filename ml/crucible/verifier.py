"""Tier 2 deterministic verifier for Lexel rewrites and training candidates.

Ports `crates/lexel-core/src/verifier.rs` and `crates/lexel-core/src/surfaces.rs`:
- Unit-bound metric extraction (`UNIT_BOUND_REGEX`) distinguishing `#42` from `42%`, `18ms`, `$42`, `42MB`, `16px`.
- Code, URL, and CLI flag (`--flag`) token extraction and 100% preservation checks.
- Surface profile compliance validator (`minChars`, `maxChars`, `allowLinks`, `allowEmojis`, `allowHashtags`, `allowEmDashes`, `bannedOpeners`, and `ide_git_commit` rules: subject <= 72 chars, no trailing period, imperative mood).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Sequence

from ml.crucible.config import (
    SurfaceProfile,
    load_slop_config,
    load_surface_catalog,
)

# Unit-bound metric regex matching `crates/lexel-core/src/verifier.rs` plus `px`, `tb`, `us`
UNIT_BOUND_REGEX = re.compile(
    r"(?i)(?:(?<=^)|(?<=[\s(\[\"'`]))(#|\$)?(\d+(?:[.,]\d+)?)\s*(%|ms|us|µs|s|sec|min|hrs?|kb|mb|gb|tb|px|x|k|m|b)?(?=$|[\s,.;:!?/\)\]\'\"`])"
)

FENCE_RE = re.compile(r"```[\s\S]*?```")
INLINE_BACKTICK_RE = re.compile(r"`[^`\n]+`")
QUOTE_LINE_RE = re.compile(r"(?m)^[ \t]*>.*$")
URL_RE = re.compile(r"(?i)https?://[^\s)>\]\"']+")
CLI_FLAG_RE = re.compile(r"(?:(?<=^)|(?<=[\s(\[\"`']))(--[a-zA-Z0-9][a-zA-Z0-9_-]*)(?=$|[\s,.;:!?=\)\]\'\"`])")
HASHTAG_RE = re.compile(r"(?:^|\s)(#[a-zA-Z][a-zA-Z0-9_]{1,})")
EXCESS_PUNCT_RE = re.compile(r"!{3,}|\?{3,}")
COMMIT_PREFIX_RE = re.compile(r"^([A-Za-z]+)(?:\(([^)]+)\))?(!)?:\s*(.*)$")

VALID_COMMIT_TYPES: frozenset[str] = frozenset(
    {
        "feat",
        "fix",
        "perf",
        "refactor",
        "sec",
        "arch",
        "ml",
        "sync",
        "test",
        "infra",
        "docs",
        "revert",
        "chore",
        "ci",
        "build",
        "style",
    }
)

PAST_TENSE_COMMIT_VERBS: tuple[str, ...] = (
    "added ",
    "fixed ",
    "updated ",
    "removed ",
    "changed ",
    "resolved ",
    "implemented ",
    "refactored ",
)


@dataclass(frozen=True)
class UnitMetric:
    raw: str
    value: float
    unit: str


@dataclass(frozen=True)
class SurfaceViolation:
    kind: str
    message: str
    start: int
    end: int


@dataclass
class GateCheckSummary:
    zero_slop: bool
    numbers_preserved: bool
    tokens_preserved: bool
    surface_compliant: bool
    missing_metrics: list[UnitMetric] = field(default_factory=list)
    invented_metrics: list[UnitMetric] = field(default_factory=list)
    missing_tokens: list[str] = field(default_factory=list)
    slop_hits: list[str] = field(default_factory=list)
    surface_violations: list[SurfaceViolation] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def passed_all(self) -> bool:
        return (
            self.zero_slop
            and self.numbers_preserved
            and self.tokens_preserved
            and self.surface_compliant
        )


def ignored_prose_ranges(text: str) -> list[tuple[int, int]]:
    """Compute character ranges for fenced code blocks, inline backticks, and `> ` quote lines."""
    ranges: list[tuple[int, int]] = []
    for regex in (FENCE_RE, INLINE_BACKTICK_RE, QUOTE_LINE_RE):
        for m in regex.finditer(text):
            ranges.append((m.start(), m.end()))
    ranges.sort()
    return ranges


def overlaps_ignored_ranges(
    start: int, end: int, ignored: Sequence[tuple[int, int]]
) -> bool:
    """Return True when `[start, end)` overlaps any ignored range."""
    for ig_start, ig_end in ignored:
        if start < ig_end and end > ig_start:
            return True
    return False


def sanitize_model_output(raw: str) -> str:
    """Strip wrapper artifacts (`<think>...</think>`, markdown code fences, outer quotes) from model output."""
    cleaned = raw.strip()
    cleaned = re.sub(r"(?is)<think>.*?</think>", "", cleaned).strip()
    if cleaned.startswith("```") and cleaned.endswith("```"):
        cleaned = re.sub(r"(?is)^```[a-z0-9_-]*\n?|\n?```$", "", cleaned).strip()
    if (
        len(cleaned) >= 2
        and (
            (cleaned.startswith('"') and cleaned.endswith('"'))
            or (cleaned.startswith("'") and cleaned.endswith("'"))
        )
    ):
        cleaned = cleaned[1:-1].strip()
    return cleaned


def extract_unit_bound_metrics(text: str) -> list[UnitMetric]:
    """Extract unit-bound numbers distinguishing `#42` from `42%`, `18ms`, `$42`, `42MB`, `16px`."""
    metrics: list[UnitMetric] = []
    for m in UNIT_BOUND_REGEX.finditer(text):
        num_str = m.group(2)
        if not num_str:
            continue
        cleaned = num_str.replace(",", "")
        try:
            value = float(cleaned)
        except ValueError:
            continue
        prefix = m.group(1) or ""
        suffix = (m.group(3) or "").lower()
        if prefix:
            unit = prefix
        elif suffix:
            unit = suffix
        else:
            unit = "count"
        raw = m.group(0).strip(" \t\n\r()[].,;:!?/'\"`")
        metrics.append(UnitMetric(raw=raw, value=value, unit=unit))
    return metrics


def extract_code_and_url_tokens(text: str) -> list[str]:
    """Extract inline backtick spans, `https?://` URLs, and CLI flags (`--flag`)."""
    tokens: list[str] = []
    for m in INLINE_BACKTICK_RE.finditer(text):
        tok = m.group(0)
        if tok not in tokens:
            tokens.append(tok)
    for m in URL_RE.finditer(text):
        tok = m.group(0).rstrip(".,;:!?)")
        if tok not in tokens:
            tokens.append(tok)
    for m in CLI_FLAG_RE.finditer(text):
        tok = m.group(1)
        if tok not in tokens:
            tokens.append(tok)
    return tokens


def scan_slop_terms(
    text: str,
    allow_em_dashes: bool = False,
    include_extended: bool = False,
) -> list[dict[str, object]]:
    """Scan `text` for banned AI buzzwords and em dashes (`\u2014` or ` -- `) outside code spans and blockquotes."""
    cfg = load_slop_config()
    terms = cfg.all_banned_terms if include_extended else cfg.slop_terms
    ignored = ignored_prose_ranges(text)
    hits: list[dict[str, object]] = []

    for term in terms:
        pat = re.compile(rf"(?i)\b{re.escape(term)}\b")
        for m in pat.finditer(text):
            if overlaps_ignored_ranges(m.start(), m.end(), ignored):
                continue
            hits.append(
                {
                    "term": m.group(0),
                    "canonical": term.lower(),
                    "start": m.start(),
                    "end": m.end(),
                    "is_em_dash": False,
                }
            )

    if cfg.em_dash_forbidden and not allow_em_dashes:
        em_pat = re.compile("\u2014| -- ")
        for m in em_pat.finditer(text):
            if overlaps_ignored_ranges(m.start(), m.end(), ignored):
                continue
            hits.append(
                {
                    "term": m.group(0),
                    "canonical": "em_dash",
                    "start": m.start(),
                    "end": m.end(),
                    "is_em_dash": True,
                }
            )

    hits.sort(key=lambda h: int(h["start"]))
    return hits


def _is_decorative_emoji(ch: str) -> bool:
    cp = ord(ch)
    return (
        0x1F300 <= cp <= 0x1FAFF
        or 0x2600 <= cp <= 0x27BF
        or 0x2300 <= cp <= 0x23FF
    )


def _validate_git_commit(text: str, violations: list[SurfaceViolation]) -> None:
    offset = 0
    for line in text.splitlines(keepends=True):
        trimmed = line.strip()
        if not trimmed or trimmed.startswith("#"):
            offset += len(line)
            continue
        subject = line.rstrip("\r\n")
        subject_chars = len(subject)
        if subject_chars > 72:
            violations.append(
                SurfaceViolation(
                    kind="commit_subject_length",
                    message=f"Git commit subject should stay <= 72 chars ({subject_chars} chars).",
                    start=offset + min(72, len(subject)),
                    end=offset + len(subject),
                )
            )
        if subject.endswith("."):
            violations.append(
                SurfaceViolation(
                    kind="commit_subject_period",
                    message="Drop the trailing period on Git commit subject lines.",
                    start=offset + max(0, len(subject) - 1),
                    end=offset + len(subject),
                )
            )
        summary_part = subject
        m = COMMIT_PREFIX_RE.match(subject)
        if m:
            ctype = m.group(1)
            if ctype not in VALID_COMMIT_TYPES:
                violations.append(
                    SurfaceViolation(
                        kind="commit_type",
                        message=f'Commit prefix "{ctype}" should be lowercase standard type (e.g. feat, fix, refactor, docs).',
                        start=offset + m.start(1),
                        end=offset + m.end(1),
                    )
                )
            if m.group(4) is not None:
                summary_part = m.group(4)

        lower_summary = summary_part.lstrip().lower()
        for past in PAST_TENSE_COMMIT_VERBS:
            if lower_summary.startswith(past):
                past_start = offset + (len(subject) - len(summary_part.lstrip()))
                violations.append(
                    SurfaceViolation(
                        kind="commit_mood",
                        message='Use imperative mood in commit subjects (e.g. "add" instead of "added").',
                        start=past_start,
                        end=past_start + len(past.rstrip()),
                    )
                )
                break
        break


def validate_surface_compliance(
    text: str,
    surface_id: str,
    custom_surfaces: Sequence[SurfaceProfile] = (),
    enforce_min_chars: bool = True,
) -> list[SurfaceViolation]:
    """Validate `text` against a surface profile's deterministic bounds and formatting rules."""
    catalog = load_surface_catalog(custom_surfaces=custom_surfaces)
    profile = catalog.get(surface_id)
    violations: list[SurfaceViolation] = []
    ignored = ignored_prose_ranges(text)

    trimmed_start = text.lstrip()
    leading_offset = len(text) - len(trimmed_start)
    lower_trimmed = trimmed_start.lower()
    for opener in profile.banned_openers:
        if lower_trimmed.startswith(opener.lower()):
            violations.append(
                SurfaceViolation(
                    kind="opener",
                    message=f"Generic opener on {profile.label}. Start directly with your point.",
                    start=leading_offset,
                    end=leading_offset + len(opener),
                )
            )
            break

    if not profile.allow_links:
        for m in URL_RE.finditer(text):
            if overlaps_ignored_ranges(m.start(), m.end(), ignored):
                continue
            violations.append(
                SurfaceViolation(
                    kind="link",
                    message=f"External links are often auto-removed or flagged as spam on {profile.label}.",
                    start=m.start(),
                    end=m.end(),
                )
            )

    if not profile.allow_hashtags:
        for m in HASHTAG_RE.finditer(text):
            tag_start, tag_end = m.span(1)
            if overlaps_ignored_ranges(tag_start, tag_end, ignored):
                continue
            violations.append(
                SurfaceViolation(
                    kind="hashtag",
                    message=f"Hashtags reduce signal quality on {profile.label}.",
                    start=tag_start,
                    end=tag_end,
                )
            )

    if not profile.allow_emojis:
        for idx, ch in enumerate(text):
            if _is_decorative_emoji(ch) and not overlaps_ignored_ranges(
                idx, idx + 1, ignored
            ):
                violations.append(
                    SurfaceViolation(
                        kind="emoji",
                        message=f"Decorative emoji flagged by {profile.label} profile.",
                        start=idx,
                        end=idx + 1,
                    )
                )

    if not profile.allow_em_dashes:
        em_pat = re.compile("\u2014| -- ")
        for m in em_pat.finditer(text):
            if overlaps_ignored_ranges(m.start(), m.end(), ignored):
                continue
            violations.append(
                SurfaceViolation(
                    kind="em_dash",
                    message=f"Em dashes are disallowed on {profile.label}.",
                    start=m.start(),
                    end=m.end(),
                )
            )

    if profile.id not in ("web_discord_slack", "general"):
        for m in EXCESS_PUNCT_RE.finditer(text):
            if overlaps_ignored_ranges(m.start(), m.end(), ignored):
                continue
            violations.append(
                SurfaceViolation(
                    kind="excess_punctuation",
                    message=f"Repeated punctuation ({m.group(0)}) lowers clarity on {profile.label}.",
                    start=m.start(),
                    end=m.end(),
                )
            )

    if profile.id == "ide_git_commit":
        _validate_git_commit(text, violations)

    char_count = len(text.strip())
    if enforce_min_chars and char_count < profile.min_chars:
        violations.append(
            SurfaceViolation(
                kind="min_length",
                message=f"Below {profile.label} minimum ({char_count}/{profile.min_chars} chars).",
                start=0,
                end=len(text),
            )
        )
    if len(text) > profile.max_chars:
        violations.append(
            SurfaceViolation(
                kind="length",
                message=f"Exceeds {profile.label} limit ({len(text)}/{profile.max_chars} chars).",
                start=profile.max_chars,
                end=len(text),
            )
        )

    return violations


def verify_rewrite(
    source: str,
    candidate: str,
    surface_id: str = "general",
    custom_surfaces: Sequence[SurfaceProfile] = (),
    include_extended_slop: bool = False,
) -> GateCheckSummary:
    """Tier 2 deterministic gatekeeper validating AI rewrite candidates."""
    catalog = load_surface_catalog(custom_surfaces=custom_surfaces)
    profile = catalog.get(surface_id)
    warnings: list[str] = []

    raw_slop_hits = scan_slop_terms(
        candidate,
        allow_em_dashes=profile.allow_em_dashes,
        include_extended=include_extended_slop,
    )
    zero_slop = len(raw_slop_hits) == 0
    slop_terms_found: list[str] = []
    for hit in raw_slop_hits:
        if hit["is_em_dash"]:
            warnings.append("Contains an em dash.")
            slop_terms_found.append("em_dash")
        else:
            term_str = str(hit["term"])
            warnings.append(f'Contains AI phrasing: "{term_str}"')
            slop_terms_found.append(term_str.lower())

    source_metrics = extract_unit_bound_metrics(source)
    candidate_metrics = extract_unit_bound_metrics(candidate)

    missing_metrics = [
        sm
        for sm in source_metrics
        if not any(
            abs(cm.value - sm.value) < 1e-9 and cm.unit == sm.unit
            for cm in candidate_metrics
        )
    ]
    invented_metrics = [
        cm
        for cm in candidate_metrics
        if not any(
            abs(sm.value - cm.value) < 1e-9 and sm.unit == cm.unit
            for sm in source_metrics
        )
    ]
    numbers_preserved = len(missing_metrics) == 0 and len(invented_metrics) == 0
    if missing_metrics:
        joined = ", ".join(m.raw for m in missing_metrics)
        warnings.append(f"Source number altered/dropped: {joined}")
    if invented_metrics:
        joined = ", ".join(m.raw for m in invented_metrics)
        warnings.append(f"Ungrounded number introduced: {joined}")

    source_tokens = extract_code_and_url_tokens(source)
    missing_tokens = [
        tok
        for tok in source_tokens
        if tok not in candidate and tok.strip("`") not in candidate
    ]
    # Also enforce exact backtick/URL/CLI token match for verify_rewrite strict mode
    strict_missing_tokens = [tok for tok in source_tokens if tok not in candidate]
    tokens_preserved = len(strict_missing_tokens) == 0
    if not tokens_preserved:
        warnings.append(f"Dropped code/URL token: {', '.join(strict_missing_tokens)}")

    surface_violations = validate_surface_compliance(
        candidate,
        surface_id=surface_id,
        custom_surfaces=custom_surfaces,
        enforce_min_chars=True,
    )
    surface_compliant = (
        len(surface_violations) == 0 and len(candidate) <= profile.max_chars
    )
    for v in surface_violations:
        warnings.append(v.message)

    return GateCheckSummary(
        zero_slop=zero_slop,
        numbers_preserved=numbers_preserved,
        tokens_preserved=tokens_preserved,
        surface_compliant=surface_compliant,
        missing_metrics=missing_metrics,
        invented_metrics=invented_metrics,
        missing_tokens=strict_missing_tokens,
        slop_hits=slop_terms_found,
        surface_violations=surface_violations,
        warnings=warnings,
    )
