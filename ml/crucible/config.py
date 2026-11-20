"""Single Source of Truth loader and prompt builder for Lexel Crucible.

Implements Architecture Invariant #3:
- Loads `/home/lawand/Lexel/rules/slop_terms.json` directly.
- Loads `/home/lawand/Lexel/ml/personas/surfaces.json` directly.
- Builds rewrite messages matching `crates/lexel-core/src/prompt.rs`
  (`build_rewrite_messages_with_surfaces`) byte-for-byte.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

REPO_ROOT = Path(__file__).resolve().parents[2]


def _resolve_rule_path(env_key: str, default_rel: Path, fallback_filename: str) -> Path:
    env_val = os.environ.get(env_key)
    if env_val and Path(env_val).is_file():
        return Path(env_val)
    primary = REPO_ROOT / default_rel
    if primary.is_file():
        return primary
    for base in (
        Path(os.environ.get("LEXEL_DATA_DIR", "")),
        Path.cwd(),
        Path.cwd() / "ml" / "datasets",
        Path("/kaggle/input/lexel-crucible-datasets"),
        Path("/kaggle/working"),
    ):
        cand = base / fallback_filename
        if cand.is_file():
            return cand
    if Path("/kaggle/input").is_dir():
        matches = sorted(Path("/kaggle/input").rglob(fallback_filename))
        if matches:
            return matches[0]
    return primary


SLOP_TERMS_PATH = _resolve_rule_path(
    "LEXEL_SLOP_TERMS_PATH", Path("rules") / "slop_terms.json", "slop_terms.json"
)
SURFACES_PATH = _resolve_rule_path(
    "LEXEL_SURFACES_PATH", Path("ml") / "personas" / "surfaces.json", "surfaces.json"
)

ALL_SURFACE_IDS: tuple[str, ...] = (
    "web_reddit",
    "web_x",
    "web_github_pr",
    "web_linkedin",
    "web_discord_slack",
    "web_email",
    "web_substack",
    "web_wordpress",
    "web_discourse",
    "ide_git_commit",
    "ide_code_comment",
    "docs_markdown",
    "general",
)

ALL_TASK_IDS: tuple[str, ...] = (
    "fix_grammar_flow",
    "deslop",
    "rewrite_surface",
    "shorten",
    "reply_draft",
    "polish_comment",
    "polish_commit",
)

# Extended Prose banned slop lexicon (from Prose/scripts/data_crucible.py and validate_strict.py)
EXTENDED_SLOP_LEXICON: tuple[str, ...] = (
    "delve",
    "delving",
    "delved",
    "tapestry",
    "testament to",
    "in today's",
    "rapidly evolving",
    "pivotal",
    "seamless",
    "seamlessly",
    "leverage",
    "leveraging",
    "leveraged",
    "unlock",
    "unlocking",
    "unlocked",
    "game-changer",
    "game changer",
    "navigate the",
    "navigating the",
    "it's not just",
    "it is not just",
    "not merely",
    "embark",
    "embarking",
    "embarked",
    "journey",
    "cutting-edge",
    "synergy",
    "synergies",
    "paradigm",
    "paradigms",
    "paradigm shift",
    "holistic",
    "holistically",
    "furthermore",
    "moreover",
    "in conclusion",
    "ever-evolving",
    "realm",
    "realms",
    "harness",
    "harnessing",
    "elevate",
    "elevating",
    "foster",
    "fostering",
    "fostered",
    "underscore",
    "underscores",
    "underscoring",
    "revolutionize",
    "revolutionizing",
    "next-generation",
    "beacon",
    "transformative",
    "transformative leap",
    "unparalleled",
    "humbled and thrilled",
    "pleased to announce",
    "catalyst for",
    "unwavering dedication",
    "world-class",
)

FILLER_PHRASES: tuple[str, ...] = (
    "in order to",
    "at the end of the day",
    "needless to say",
    "it is important to note that",
    "it is worth noting that",
    "as a matter of fact",
    "with that being said",
    "in light of the fact that",
    "for the purpose of",
    "at this point in time",
)

THROAT_CLEARING_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(
        r"^(?:certainly|sure|absolutely|here is|here's|in this post|in this article|let's dive|of course|i'd be happy to)",
        re.IGNORECASE,
    ),
    re.compile(r"^(?:as an ai|as requested|below is|sure,?\s+here)", re.IGNORECASE),
    re.compile(r"^(?:first and foremost|to begin with|first of all)", re.IGNORECASE),
)

PREACHY_CONCLUSION_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(
        r"(?:in conclusion|to sum up|all in all|in summary|the future looks bright|only time will tell)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"(?:embracing these principles will ensure|by fostering a culture of)\b",
        re.IGNORECASE,
    ),
)


@dataclass(frozen=True)
class SlopConfig:
    version: int
    em_dash_forbidden: bool
    slop_terms: tuple[str, ...]
    safe_replacements: dict[str, str]
    extended_terms: tuple[str, ...]

    @property
    def all_banned_terms(self) -> tuple[str, ...]:
        seen: dict[str, None] = {}
        for t in (*self.slop_terms, *self.extended_terms):
            seen[t.lower()] = None
        return tuple(seen.keys())


@dataclass(frozen=True)
class QuickActionDef:
    id: str
    label: str


@dataclass(frozen=True)
class SurfaceProfile:
    id: str
    label: str
    host_patterns: tuple[str, ...]
    path_regex: str | None
    register: str
    min_chars: int
    max_chars: int
    allow_links: bool
    allow_emojis: bool
    allow_hashtags: bool
    allow_em_dashes: bool
    banned_openers: tuple[str, ...]
    prompt_directive: str
    quick_actions: tuple[QuickActionDef, ...] = field(default_factory=tuple)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> SurfaceProfile:
        actions = tuple(
            QuickActionDef(id=str(a["id"]), label=str(a["label"]))
            for a in raw.get("quickActions", ())
        )
        return cls(
            id=str(raw["id"]),
            label=str(raw["label"]),
            host_patterns=tuple(str(h) for h in raw.get("hostPatterns", ())),
            path_regex=raw.get("pathRegex"),
            register=str(raw["register"]),
            min_chars=int(raw["minChars"]),
            max_chars=int(raw["maxChars"]),
            allow_links=bool(raw["allowLinks"]),
            allow_emojis=bool(raw["allowEmojis"]),
            allow_hashtags=bool(raw["allowHashtags"]),
            allow_em_dashes=bool(raw["allowEmDashes"]),
            banned_openers=tuple(str(o) for o in raw.get("bannedOpeners", ())),
            prompt_directive=str(raw["promptDirective"]),
            quick_actions=actions,
        )


@dataclass(frozen=True)
class VoiceExample:
    id: str
    profile_id: str
    surface_id: str
    subcontext: str | None
    original: str
    rewritten: str
    action: str
    created_at: int


@dataclass(frozen=True)
class ChatMessage:
    role: str
    content: str

    def to_dict(self) -> dict[str, str]:
        return {"role": self.role, "content": self.content}


class SurfaceCatalog:
    """Surface catalog backed by `ml/personas/surfaces.json`."""

    def __init__(self, profiles: Sequence[SurfaceProfile]) -> None:
        self._profiles: list[SurfaceProfile] = list(profiles)
        self._by_id: dict[str, SurfaceProfile] = {p.id: p for p in self._profiles}

    @classmethod
    def load(
        cls,
        path: Path = SURFACES_PATH,
        custom_surfaces: Sequence[SurfaceProfile] = (),
    ) -> SurfaceCatalog:
        raw = json.loads(path.read_text(encoding="utf-8"))
        profiles = [SurfaceProfile.from_dict(item) for item in raw.get("surfaces", [])]
        by_id = {p.id: p for p in profiles}
        for custom in custom_surfaces:
            by_id[custom.id] = custom
        ordered: list[SurfaceProfile] = []
        seen: set[str] = set()
        for p in profiles:
            ordered.append(by_id[p.id])
            seen.add(p.id)
        for custom in custom_surfaces:
            if custom.id not in seen:
                ordered.append(custom)
                seen.add(custom.id)
        return cls(ordered)

    def all(self) -> list[SurfaceProfile]:
        return list(self._profiles)

    def get(self, surface_id: str) -> SurfaceProfile:
        if surface_id in self._by_id:
            return self._by_id[surface_id]
        if "general" in self._by_id:
            return self._by_id["general"]
        raise KeyError(f"unknown surface id: {surface_id}")


_SLOP_CACHE: SlopConfig | None = None
_SURFACE_CACHE: SurfaceCatalog | None = None


def load_slop_config(path: Path = SLOP_TERMS_PATH) -> SlopConfig:
    """Load `rules/slop_terms.json` directly from disk."""
    global _SLOP_CACHE
    if path == SLOP_TERMS_PATH and _SLOP_CACHE is not None:
        return _SLOP_CACHE
    raw = json.loads(path.read_text(encoding="utf-8"))
    cfg = SlopConfig(
        version=int(raw.get("version", 2)),
        em_dash_forbidden=bool(raw.get("emDashForbidden", True)),
        slop_terms=tuple(str(t) for t in raw.get("slopTerms", [])),
        safe_replacements={
            str(k): str(v) for k, v in raw.get("safeReplacements", {}).items()
        },
        extended_terms=EXTENDED_SLOP_LEXICON,
    )
    if path == SLOP_TERMS_PATH:
        _SLOP_CACHE = cfg
    return cfg


def load_surface_catalog(
    path: Path = SURFACES_PATH,
    custom_surfaces: Sequence[SurfaceProfile] = (),
) -> SurfaceCatalog:
    """Load `ml/personas/surfaces.json` directly from disk."""
    global _SURFACE_CACHE
    if path == SURFACES_PATH and not custom_surfaces and _SURFACE_CACHE is not None:
        return _SURFACE_CACHE
    cat = SurfaceCatalog.load(path=path, custom_surfaces=custom_surfaces)
    if path == SURFACES_PATH and not custom_surfaces:
        _SURFACE_CACHE = cat
    return cat


def task_instruction(task: str) -> str:
    """Return task directive matching `crates/lexel-core/src/prompt.rs` plus comment/commit aliases."""
    normalized = task.strip().lower()
    if normalized == "fix_grammar_flow":
        return "Fix grammar, spelling, and awkward phrasing with minimal edits. Keep the author voice intact."
    if normalized == "deslop":
        return "Remove AI buzzwords, corporate padding, filler openers, and em dashes. Make every sentence direct and human."
    if normalized == "rewrite_surface":
        return "Rewrite the text to fit the target platform register and length rules naturally."
    if normalized == "shorten":
        return "Shorten by 30 to 50 percent while preserving every key fact, number, URL, and code token."
    if normalized == "reply_draft":
        return "Draft a concise, grounded reply based only on the author draft/notes and the provided thread context. Do not invent facts."
    if normalized == "polish_comment":
        return "Explain why, invariants, or edge cases concisely in a code comment. Preserve backticks and identifier names untouched."
    if normalized == "polish_commit":
        return "Write an imperative Git commit message with a subject line under 72 characters without a trailing period. Keep commit scope, file paths, and issue IDs intact."
    raise ValueError(f"Unsupported task id: {task!r}. Expected one of {ALL_TASK_IDS}")


def _tokenize_words(text: str) -> set[str]:
    """Match `tokenize_words` in `crates/lexel-core/src/prompt.rs`."""
    lower = text.lower()
    tokens = re.split(r"[^a-z0-9_]+", lower)
    return {w for w in tokens if len(w) >= 3}


def select_relevant_voice_examples(
    examples: Sequence[VoiceExample],
    surface_id: str,
    source_text: str,
    limit: int = 2,
) -> list[VoiceExample]:
    """Rank up to `limit` stored voice examples by surface match and token overlap."""
    query_words = _tokenize_words(source_text)
    scored: list[tuple[int, int, VoiceExample]] = []
    for ex in examples:
        if ex.surface_id != surface_id and ex.surface_id != "general":
            continue
        score = 10 if ex.surface_id == surface_id else 1
        combined = f"{ex.original} {ex.rewritten}"
        ex_words = _tokenize_words(combined)
        for w in query_words:
            if w in ex_words:
                score += 2
        scored.append((score, ex.created_at, ex))

    scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return [item[2] for item in scored[:limit]]


def build_rewrite_messages(
    text: str,
    task: str,
    surface_id: str,
    subcontext: str | None = None,
    thread_context: str | None = None,
    voice_examples: Sequence[VoiceExample] = (),
) -> list[ChatMessage]:
    """Build structured system/user chat messages matching `crates/lexel-core/src/prompt.rs` byte-for-byte."""
    return build_rewrite_messages_with_surfaces(
        text=text,
        task=task,
        surface_id=surface_id,
        subcontext=subcontext,
        thread_context=thread_context,
        voice_examples=voice_examples,
        custom_surfaces=(),
    )


def build_rewrite_messages_with_surfaces(
    text: str,
    task: str,
    surface_id: str,
    subcontext: str | None = None,
    thread_context: str | None = None,
    voice_examples: Sequence[VoiceExample] = (),
    custom_surfaces: Sequence[SurfaceProfile] = (),
) -> list[ChatMessage]:
    """Build structured system/user chat messages matching `crates/lexel-core/src/prompt.rs` byte-for-byte."""
    catalog = load_surface_catalog(custom_surfaces=custom_surfaces)
    profile = catalog.get(surface_id)
    selected = select_relevant_voice_examples(voice_examples, surface_id, text, limit=2)

    # Note: the em-dash literal in the system prompt below is required for byte-for-byte
    # parity with `crates/lexel-core/src/prompt.rs` line 113.
    em_dash_char = "\u2014"
    system_lines: list[str] = [
        "You are Lexel, a precise human writing editor.",
        "Rules:",
        "- Output ONLY the rewritten text. No preamble, no quotes, no explanation.",
        "- Preserve every number, metric, ID (#42), URL, and `code` token exactly.",
        f"- Never use em dashes ({em_dash_char}) or AI buzzwords (delve, tapestry, seamless, leverage, game-changer, unlock, pivotal).",
        f"- Surface: {profile.label} ({profile.id})",
    ]

    if subcontext is not None and subcontext.strip():
        system_lines.append(f"- Subcontext: {subcontext.strip()}")

    system_lines.append(f"- Platform style: {profile.prompt_directive}")
    system_lines.append(f"- Max characters: {profile.max_chars}")
    system_lines.append(f"- Task: {task_instruction(task)}")

    if selected:
        system_lines.append("<voice_examples>")
        for ex in selected:
            compact = " ".join(ex.rewritten.split())
            system_lines.append(f"- {compact}")
        system_lines.append("</voice_examples>")

    user_parts: list[str] = []
    if thread_context is not None and thread_context.strip():
        clipped = thread_context.strip()[:1200]
        user_parts.append(f"<thread_context>\n{clipped}\n</thread_context>")
    user_parts.append(f"<source>\n{text.strip()}\n</source>")

    return [
        ChatMessage(role="system", content="\n".join(system_lines)),
        ChatMessage(role="user", content="\n\n".join(user_parts)),
    ]


def build_tagged_prompt_pair(
    text: str,
    task: str,
    surface_id: str,
    subcontext: str | None = None,
    thread_context: str | None = None,
    voice_examples: Sequence[VoiceExample] = (),
    custom_surfaces: Sequence[SurfaceProfile] = (),
) -> dict[str, str]:
    """Return both the canonical `lexel-core` messages and explicit XML-tagged fields (`<surface>`, `<subcontext>`, `<task>`, `<surface_rules>`, `<voice_examples>`, `<thread_context>`, `<source>`)."""
    catalog = load_surface_catalog(custom_surfaces=custom_surfaces)
    profile = catalog.get(surface_id)
    selected = select_relevant_voice_examples(voice_examples, surface_id, text, limit=2)
    messages = build_rewrite_messages_with_surfaces(
        text=text,
        task=task,
        surface_id=surface_id,
        subcontext=subcontext,
        thread_context=thread_context,
        voice_examples=voice_examples,
        custom_surfaces=custom_surfaces,
    )

    xml_blocks = [
        f"<surface>{profile.id}</surface>",
        f"<subcontext>{(subcontext or '').strip()}</subcontext>",
        f"<task>{task}: {task_instruction(task)}</task>",
        f"<surface_rules>label={profile.label}; register={profile.register}; min_chars={profile.min_chars}; max_chars={profile.max_chars}; allow_links={profile.allow_links}; allow_emojis={profile.allow_emojis}; allow_hashtags={profile.allow_hashtags}; allow_em_dashes={profile.allow_em_dashes}; directive={profile.prompt_directive}</surface_rules>",
    ]
    if selected:
        examples_body = "\n".join(f"- {' '.join(ex.rewritten.split())}" for ex in selected)
        xml_blocks.append(f"<voice_examples>\n{examples_body}\n</voice_examples>")
    if thread_context and thread_context.strip():
        xml_blocks.append(f"<thread_context>\n{thread_context.strip()[:1200]}\n</thread_context>")
    xml_blocks.append(f"<source>\n{text.strip()}\n</source>")

    return {
        "system": messages[0].content,
        "user": messages[1].content,
        "tagged_prompt": "\n".join(xml_blocks),
    }
