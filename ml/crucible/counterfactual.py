"""Surgical Counterfactual Mutation (SCM) and Reverse-Slop SFT Synthesizer for Lexel.

Ported and extended from `/home/lawand/Prose/src/wlab/counterfactual.py`:
- `PerturbationType`:
  - `NUMERICAL`: distorts unit-bound numbers, latencies, percentages, or issue IDs.
  - `ENTITY_SWAP`: swaps technical entities (databases, runtimes, protocols).
  - `AI_SLOP`: injects banned AI buzzwords and corporate filler.
  - `NEGATION`: inverts causality or negation claims.
  - `EM_DASH_INJECTION`: injects forbidden em dashes (`\u2014`) or spaced double hyphens (` -- `).
  - `CODE_TOKEN_DROP`: drops or mangles backtick tokens, URLs, or CLI flags (`--flag`).
  - `SURFACE_VIOLATION`: injects banned surface openers, forbidden hashtags/emojis, or commit trailing period.
- Records exact character offsets `[start_char, end_char)` and maps them to token-level binary loss masks (`align_spans_to_token_mask` -> `rejected_token_mask`).
- `inject_reverse_slop`: takes clean human prose/commits/comments (`target`/`assistant`) and deterministically injects AI buzzwords, em dashes, passive filler, or banned openers to create realistic `<source>` (`user`) inputs while preserving 100% of unit-bound numbers and code/URL tokens.
"""

from __future__ import annotations

import random
import re
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Sequence

from ml.crucible.config import load_surface_catalog
from ml.crucible.verifier import (
    CLI_FLAG_RE,
    INLINE_BACKTICK_RE,
    UNIT_BOUND_REGEX,
    URL_RE,
    ignored_prose_ranges,
    overlaps_ignored_ranges,
)


class PerturbationType(str, Enum):
    NUMERICAL = "numerical_hallucination"
    ENTITY_SWAP = "entity_swap"
    AI_SLOP = "corporate_slop"
    NEGATION = "negation_inversion"
    EM_DASH_INJECTION = "em_dash_injection"
    CODE_TOKEN_DROP = "code_token_drop"
    SURFACE_VIOLATION = "surface_violation"


@dataclass
class PerturbedSpan:
    original: str
    perturbed: str
    start_char: int
    end_char: int
    perturbation_type: PerturbationType

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["perturbation_type"] = self.perturbation_type.value
        return d


@dataclass
class PreferencePair:
    pair_id: str
    example_id: str
    surface_id: str
    task: str
    prompt: str
    chosen: str
    rejected: str
    perturbation_type: PerturbationType
    perturbed_spans: list[dict[str, Any]]
    rejected_token_mask: list[int] = field(default_factory=list)
    messages: list[dict[str, str]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "pair_id": self.pair_id,
            "example_id": self.example_id,
            "surface_id": self.surface_id,
            "task": self.task,
            "prompt": self.prompt,
            "chosen": self.chosen,
            "rejected": self.rejected,
            "perturbation_type": self.perturbation_type.value,
            "perturbed_spans": self.perturbed_spans,
            "rejected_token_mask": self.rejected_token_mask,
            "messages": self.messages,
        }


ENTITY_SWAP_MAP: dict[str, list[str]] = {
    "PostgreSQL": ["MongoDB", "MySQL 5.6", "DynamoDB", "CouchDB"],
    "postgres": ["mongo", "mysql", "dynamo"],
    "RocksDB": ["SQLite", "LevelDB", "BerkeleyDB"],
    "Redis": ["Memcached", "Varnish", "Aerospike"],
    "Kafka": ["RabbitMQ", "ActiveMQ", "SQS", "ZeroMQ"],
    "ClickHouse": ["Amazon Redshift", "Snowflake", "Cassandra"],
    "SQLite": ["IndexedDB", "LocalStorage", "FlatFile"],
    "Rust": ["Go", "C++11", "Java 8", "Node.js"],
    "Python": ["Perl", "Ruby", "PHP"],
    "TypeScript": ["Vanilla JavaScript", "Flow", "CoffeeScript"],
    "JavaScript": ["PHP", "Lua", "Perl"],
    "Kubernetes": ["Docker Swarm", "Nomad", "Apache Mesos"],
    "k8s": ["swarm", "mesos"],
    "Docker": ["LXC", "Podman", "Vagrant"],
    "Linux": ["FreeBSD", "Windows Server", "Solaris"],
    "macOS": ["Windows XP", "Solaris", "FreeBSD"],
    "Windows": ["FreeBSD", "OpenBSD", "Solaris"],
    "systemd": ["SysVinit", "Upstart", "OpenRC"],
    "eBPF": ["libpcap", "kernel modules", "iptables"],
    "TLS 1.3": ["SSL 3.0", "TLS 1.0", "plaintext HTTP"],
    "HTTP/2": ["HTTP/1.1", "HTTP/0.9"],
    "HTTP/3": ["HTTP/1.0", "FTP", "Telnet"],
    "QUIC": ["TCP", "SCTP"],
    "OAuth2": ["HTTP Basic Auth", "Kerberos", "NTLM"],
    "GitHub": ["Bitbucket", "SourceForge", "Subversion"],
    "Git": ["Subversion", "Mercurial", "CVS"],
    "Chromium": ["Internet Explorer", "Opera Presto", "Safari 9"],
    "Firefox": ["Internet Explorer", "Edge Legacy", "Konqueror"],
    "Chrome": ["Internet Explorer", "Safari 10", "Lynx"],
    "Neovim": ["Nano", "Notepad", "Eclipse"],
    "VS Code": ["Notepad++", "Sublime Text 2", "NetBeans"],
    "Obsidian": ["WordPad", "Apple Notes", "Google Keep"],
    "Emacs": ["Nano", "Pico", "Notepad"],
    "Helix": ["Nano", "Ed", "WordPad"],
    "WebAssembly": ["Flash", "Java Applet", "Silverlight"],
    "WASM": ["ActiveX", "Flash", "JVM bytecode"],
    "Markdown": ["RTF", "WordPerfect", "LaTeX 2.09"],
    "JSON": ["XML", "INI", "SOAP"],
    "TOML": ["XML", "INI", "CSV"],
    "YAML": ["XML", "CSV", "INI"],
    "HTML": ["PostScript", "RTF", "XAML"],
    "CSS": ["XSLT", "inline tables", "Flash styles"],
    "React": ["jQuery", "AngularJS 1.x", "Backbone.js"],
    "Vite": ["Gulp", "Grunt", "Browserify"],
    "Tailwind": ["Bootstrap 3", "Foundation 4", "inline styles"],
    "Tauri": ["Electron", "Java Swing", "GTK2"],
    "Electron": ["Java Applet", "Silverlight", "ActiveX"],
    "Cargo": ["Make", "Maven", "Ant"],
    "Harper": ["Grammarly", "LanguageTool", "Hunspell"],
    "Lexel": ["Grammarly", "ProWritingAid", "QuillBot"],
    "PyTorch": ["Theano", "Caffe", "MXNet"],
    "CUDA": ["OpenCL", "DirectCompute", "WebGL"],
    "Unsloth": ["DeepSpeed ZeRO-3", "Megatron-LM", "Fairseq"],
    "GGUF": ["ONNX", "TorchScript", "SavedModel"],
    "LoRA": ["Prefix Tuning", "BitFit", "IA3"],
    "QLoRA": ["Full FP32 FT", "BitFit", "Prompt Tuning"],
    "SimPO": ["REINFORCE", "PPO", "A2C"],
    "DPO": ["PPO", "TRPO", "DQN"],
    "Qwen": ["GPT-2", "OPT-1.3B", "BLOOM-1B"],
    "Llama": ["GPT-2", "BLOOM", "Falcon-7B"],
    "Ollama": ["TorchServe", "Triton", "TensorFlow Serving"],
    "Nginx": ["Apache 1.3", "IIS 6", "Lighttpd"],
    "Cloudflare": ["Akamai Legacy", "Fastly", "Squid Proxy"],
    "Terraform": ["Chef", "Puppet", "CFEngine"],
    "Unicode": ["ASCII", "EBCDIC", "Latin-1"],
    "UTF-8": ["UTF-32", "Latin-1", "EBCDIC"],
    "ASCII": ["EBCDIC", "UTF-32", "Shift-JIS"],
    "LSP": ["SOAP", "CORBA", "XML-RPC"],
    "SQL": ["XQuery", "LDAP", "SPARQL"],
    "DOM": ["Shadow Canvas", "XUL", "Flash Stage"],
    "API": ["FTP", "SMTP", "SNMP"],
    "CLI": ["GUI wizard", "SOAP endpoint", "telnet prompt"],
    "SSH": ["Telnet", "FTP", "rsh"],
    "URL": ["UNC path", "URN", "file descriptor"],
    "CPU": ["FPGA", "TPU v1", "DSP"],
    "GPU": ["CPU", "ASIC", "FPGA"],
    "English": ["Latin", "Esperanto", "Old Norse"],
    "British": ["Australian", "Canadian", "Irish"],
    "American": ["Australian", "South African", "New Zealand"],
}

SLOP_SUBSTITUTIONS: list[tuple[str, str]] = [
    (r"\bbuilt\b", "seamlessly orchestrated"),
    (r"\bBuilt\b", "Seamlessly orchestrated"),
    (r"\bmigrated\b", "seamlessly transitioned across paradigms"),
    (r"\bMigrated\b", "Seamlessly transitioned across paradigms"),
    (r"\breduced\b", "unlocked a pivotal reduction in"),
    (r"\bReduced\b", "Unlocked a pivotal reduction in"),
    (r"\bfixed\b", "holistically remediated"),
    (r"\bFixed\b", "Holistically remediated"),
    (r"\bdesigned\b", "crafted a cutting-edge tapestry for"),
    (r"\bDesigned\b", "Crafted a cutting-edge tapestry for"),
    (r"\bimproved\b", "elevated to cutting-edge heights"),
    (r"\bImproved\b", "Elevated to cutting-edge heights"),
    (r"\bdeployed\b", "embarked on deploying a game-changer"),
    (r"\bDeployed\b", "Embarked on deploying a game-changer"),
    (r"\bchecked\b", "delved deep into inspecting"),
    (r"\bChecked\b", "Delved deep into inspecting"),
    (r"\bused\b", "leveraged"),
    (r"\bUsed\b", "Leveraged"),
    (r"\buses\b", "leverages"),
    (r"\bUses\b", "Leverages"),
    (r"\buse\b", "leverage"),
    (r"\bUse\b", "Leverage"),
    (r"\bexplore\b", "delve into"),
    (r"\bExplore\b", "Delve into"),
]


def perturb_numerical(
    text: str, seed: int | None = None
) -> tuple[str, list[PerturbedSpan]]:
    """Perturb a unit-bound numeric metric, percentage, or ID in `text`."""
    rng = random.Random(seed)
    matches = [m for m in UNIT_BOUND_REGEX.finditer(text) if m.group(2)]
    if not matches:
        return text, []

    m = rng.choice(matches)
    prefix = m.group(1) or ""
    val_str = m.group(2)
    suffix = m.group(3) or ""

    try:
        val = float(val_str.replace(",", ""))
    except ValueError:
        return text, []

    if prefix == "#":
        new_val_int = int(val) + rng.choice([7, 19, 100])
        new_str = f"#{new_val_int}"
    elif prefix == "$":
        factor = rng.choice([2, 5, 10])
        new_val = (
            round(val * factor, 2) if "." in val_str else int(val * factor)
        )
        new_str = f"${new_val}{suffix}"
    elif suffix == "%":
        new_val = (
            rng.choice([99.9, 84.5, 62.0])
            if val >= 90
            else round(max(1.0, val * rng.choice([0.5, 1.7])), 1)
        )
        new_str = f"{new_val}%"
    elif suffix.lower() in ("ms", "us", "µs", "s", "sec", "min", "hr", "hrs"):
        factor = rng.choice([2, 4, 10])
        new_val = (
            round(val * factor, 1) if "." in val_str else int(max(1, val * factor))
        )
        new_str = f"{new_val}{suffix}"
    else:
        factor = rng.choice([2, 3, 5])
        new_val = (
            round(val * factor, 1)
            if "." in val_str
            else int(max(1, val * factor)) + 3
        )
        new_str = f"{prefix}{new_val}{suffix}"

    num_start = m.start(1) if m.group(1) else m.start(2)
    num_end = m.end(3) if m.group(3) else m.end(2)
    orig_span = text[num_start:num_end]
    if new_str == orig_span:
        new_str = f"{prefix}{int(val) + 11}{suffix}"

    perturbed_text = text[:num_start] + new_str + text[num_end:]
    span = PerturbedSpan(
        original=orig_span,
        perturbed=new_str,
        start_char=num_start,
        end_char=num_start + len(new_str),
        perturbation_type=PerturbationType.NUMERICAL,
    )
    return perturbed_text, [span]


def perturb_entity(
    text: str, seed: int | None = None
) -> tuple[str, list[PerturbedSpan]]:
    """Surgically swap a verified technical entity with an incompatible alternative."""
    rng = random.Random(seed)
    found_entities: list[tuple[str, list[str]]] = []
    for ent, replacements in ENTITY_SWAP_MAP.items():
        pattern = re.compile(rf"\b{re.escape(ent)}\b")
        if pattern.search(text):
            found_entities.append((ent, replacements))

    if not found_entities:
        return text, []

    target_ent, replacements = rng.choice(found_entities)
    rep = rng.choice(replacements)
    pattern = re.compile(rf"\b{re.escape(target_ent)}\b")
    match = pattern.search(text)
    if not match:
        return text, []

    start_char = match.start()
    end_char = start_char + len(rep)
    perturbed_text = text[:start_char] + rep + text[match.end() :]
    span = PerturbedSpan(
        original=target_ent,
        perturbed=rep,
        start_char=start_char,
        end_char=end_char,
        perturbation_type=PerturbationType.ENTITY_SWAP,
    )
    return perturbed_text, [span]


def perturb_slop(
    text: str, seed: int | None = None
) -> tuple[str, list[PerturbedSpan]]:
    """Surgically replace direct phrasing with banned AI slop or prepend corporate filler."""
    rng = random.Random(seed)
    ignored = ignored_prose_ranges(text)
    available: list[tuple[re.Match[str], str]] = []

    for pattern_str, slop_replacement in SLOP_SUBSTITUTIONS:
        p = re.compile(pattern_str)
        for m in p.finditer(text):
            if not overlaps_ignored_ranges(m.start(), m.end(), ignored):
                available.append((m, slop_replacement))

    if available:
        match, slop_replacement = rng.choice(available)
        start_char = match.start()
        end_char = start_char + len(slop_replacement)
        perturbed_text = text[:start_char] + slop_replacement + text[match.end() :]
        span = PerturbedSpan(
            original=match.group(0),
            perturbed=slop_replacement,
            start_char=start_char,
            end_char=end_char,
            perturbation_type=PerturbationType.AI_SLOP,
        )
        return perturbed_text, [span]

    slop_fillers = [
        "In today's rapidly evolving landscape, ",
        "Furthermore, to unlock seamless synergy, ",
        "Moreover, as a testament to our cutting-edge paradigm, ",
    ]
    filler = rng.choice(slop_fillers)
    perturbed_text = filler + text
    span = PerturbedSpan(
        original="",
        perturbed=filler,
        start_char=0,
        end_char=len(filler),
        perturbation_type=PerturbationType.AI_SLOP,
    )
    return perturbed_text, [span]


def perturb_negation(
    text: str, seed: int | None = None
) -> tuple[str, list[PerturbedSpan]]:
    """Invert causality or negation to create an unsubstantiated counterfactual claim."""
    rng = random.Random(seed)
    ignored = ignored_prose_ranges(text)
    negation_pairs = [
        (r"\bdid not\b", "did"),
        (r"\bdoes not\b", "does"),
        (r"\bdo not\b", "do"),
        (r"\bwill not\b", "will"),
        (r"\bshould not\b", "should"),
        (r"\bmust not\b", "must"),
        (r"\bcannot\b", "can"),
        (r"\bcan't\b", "can"),
        (r"\bdon't\b", "do"),
        (r"\bdoesn't\b", "does"),
        (r"\bdidn't\b", "did"),
        (r"\bwon't\b", "will"),
        (r"\bisn't\b", "is"),
        (r"\baren't\b", "are"),
        (r"\bwasn't\b", "was"),
        (r"\bweren't\b", "were"),
        (r"\bhaven't\b", "have"),
        (r"\bhasn't\b", "has"),
        (r"\bno longer\b", "still"),
        (r"\bnever\b", "always"),
        (r"\balways\b", "never"),
        (r"\bwithout\b", "with"),
        (r"\bnot\b", "always"),
        (r"\bprevented\b", "triggered"),
        (r"\bprevent\b", "trigger"),
        (r"\bprevents\b", "triggers"),
        (r"\bavoided\b", "caused"),
        (r"\bavoid\b", "cause"),
        (r"\bavoids\b", "causes"),
        (r"\beliminated\b", "introduced"),
        (r"\beliminate\b", "introduce"),
        (r"\bsucceeded\b", "failed"),
        (r"\breduced\b", "increased"),
        (r"\breduce\b", "increase"),
        (r"\breduces\b", "increases"),
        (r"\bincreased\b", "decreased"),
        (r"\bincrease\b", "decrease"),
        (r"\bremoves\b", "adds"),
        (r"\bremove\b", "add"),
        (r"\bremoved\b", "added"),
        (r"\bblocks\b", "allows"),
        (r"\bblock\b", "allow"),
        (r"\brejects\b", "accepts"),
        (r"\breject\b", "accept"),
        (r"\bforbids\b", "allows"),
        (r"\brequires\b", "skips"),
        (r"\brequire\b", "skip"),
        (r"\benables\b", "disables"),
        (r"\benable\b", "disable"),
        (r"\bdisables\b", "enables"),
        (r"\bdisable\b", "enable"),
        (r"\bpasses\b", "fails"),
        (r"\bfails\b", "passes"),
        (r"\bvalid\b", "invalid"),
        (r"\binvalid\b", "valid"),
        (r"\btrue\b", "false"),
        (r"\bfalse\b", "true"),
        (r"\bbefore\b", "after"),
        (r"\bafter\b", "before"),
    ]
    candidates: list[tuple[re.Match[str], str]] = []
    for pattern_str, replacement in negation_pairs:
        p = re.compile(pattern_str, re.IGNORECASE)
        for m in p.finditer(text):
            if not overlaps_ignored_ranges(m.start(), m.end(), ignored):
                candidates.append((m, replacement))

    if not candidates:
        return text, []

    m, rep = rng.choice(candidates)
    start_char = m.start()
    end_char = start_char + len(rep)
    perturbed_text = text[:start_char] + rep + text[m.end() :]
    span = PerturbedSpan(
        original=m.group(0),
        perturbed=rep,
        start_char=start_char,
        end_char=end_char,
        perturbation_type=PerturbationType.NEGATION,
    )
    return perturbed_text, [span]


def perturb_em_dash(
    text: str, seed: int | None = None
) -> tuple[str, list[PerturbedSpan]]:
    """Inject a forbidden em dash (`\u2014`) or spaced double hyphen (` -- `) outside code spans."""
    rng = random.Random(seed)
    ignored = ignored_prose_ranges(text)
    em_dash = " \u2014 " if rng.random() < 0.75 else " -- "

    # Prefer replacing a comma or colon in prose
    punct_matches = [
        m
        for m in re.finditer(r",\s+|:\s+|;\s+", text)
        if not overlaps_ignored_ranges(m.start(), m.end(), ignored)
    ]
    if punct_matches:
        m = rng.choice(punct_matches)
        start_char = m.start()
        end_char = start_char + len(em_dash)
        perturbed_text = text[:start_char] + em_dash + text[m.end() :]
        span = PerturbedSpan(
            original=m.group(0),
            perturbed=em_dash,
            start_char=start_char,
            end_char=end_char,
            perturbation_type=PerturbationType.EM_DASH_INJECTION,
        )
        return perturbed_text, [span]

    # Fallback: insert em dash clause after first word boundary
    words = list(re.finditer(r"\b[A-Za-z]{4,}\b", text))
    valid_words = [
        w for w in words if not overlaps_ignored_ranges(w.start(), w.end(), ignored)
    ]
    if valid_words:
        w = valid_words[min(2, len(valid_words) - 1)]
        insert_str = f"{em_dash}notably{em_dash}"
        start_char = w.end()
        end_char = start_char + len(insert_str)
        perturbed_text = text[:start_char] + insert_str + text[start_char:]
        span = PerturbedSpan(
            original="",
            perturbed=insert_str,
            start_char=start_char,
            end_char=end_char,
            perturbation_type=PerturbationType.EM_DASH_INJECTION,
        )
        return perturbed_text, [span]

    return text, []


def perturb_code_token_drop(
    text: str, seed: int | None = None
) -> tuple[str, list[PerturbedSpan]]:
    """Drop or corrupt a backtick code token, URL, or CLI flag (`--flag`)."""
    rng = random.Random(seed)
    candidates: list[re.Match[str]] = []
    for regex in (INLINE_BACKTICK_RE, URL_RE, CLI_FLAG_RE):
        candidates.extend(regex.finditer(text))

    if not candidates:
        return text, []

    m = rng.choice(candidates)
    orig = m.group(0)
    if orig.startswith("`") and orig.endswith("`"):
        corrupted = "the module"
    elif orig.lower().startswith("http"):
        corrupted = "the documentation link"
    else:
        corrupted = "the option"

    start_char = m.start()
    end_char = start_char + len(corrupted)
    perturbed_text = text[:start_char] + corrupted + text[m.end() :]
    span = PerturbedSpan(
        original=orig,
        perturbed=corrupted,
        start_char=start_char,
        end_char=end_char,
        perturbation_type=PerturbationType.CODE_TOKEN_DROP,
    )
    return perturbed_text, [span]


def perturb_surface_violation(
    text: str,
    surface_id: str = "general",
    seed: int | None = None,
) -> tuple[str, list[PerturbedSpan]]:
    """Inject a surface-specific violation (banned opener, forbidden hashtag/emoji, or commit trailing period)."""
    rng = random.Random(seed)
    catalog = load_surface_catalog()
    profile = catalog.get(surface_id)

    if surface_id == "ide_git_commit":
        # Add trailing period or past-tense verb to commit subject
        first_newline = text.find("\n")
        subj_end = first_newline if first_newline != -1 else len(text)
        if not text[:subj_end].endswith("."):
            perturbed_text = text[:subj_end] + "." + text[subj_end:]
            span = PerturbedSpan(
                original="",
                perturbed=".",
                start_char=subj_end,
                end_char=subj_end + 1,
                perturbation_type=PerturbationType.SURFACE_VIOLATION,
            )
            return perturbed_text, [span]

    if profile.banned_openers:
        opener = rng.choice(profile.banned_openers)
        prefix = f"{opener.capitalize()}! "
        perturbed_text = prefix + text
        span = PerturbedSpan(
            original="",
            perturbed=prefix,
            start_char=0,
            end_char=len(prefix),
            perturbation_type=PerturbationType.SURFACE_VIOLATION,
        )
        return perturbed_text, [span]

    if not profile.allow_hashtags:
        suffix = " #TechInnovation #FutureOfWork"
        start_char = len(text)
        perturbed_text = text + suffix
        span = PerturbedSpan(
            original="",
            perturbed=suffix,
            start_char=start_char,
            end_char=start_char + len(suffix),
            perturbation_type=PerturbationType.SURFACE_VIOLATION,
        )
        return perturbed_text, [span]

    # Fallback: excessive punctuation
    suffix = "!!!"
    start_char = len(text)
    perturbed_text = text + suffix
    span = PerturbedSpan(
        original="",
        perturbed=suffix,
        start_char=start_char,
        end_char=start_char + len(suffix),
        perturbation_type=PerturbationType.SURFACE_VIOLATION,
    )
    return perturbed_text, [span]


def generate_surgical_counterfactual(
    chosen_text: str,
    target_type: PerturbationType | None = None,
    surface_id: str = "general",
    seed: int | None = None,
) -> tuple[str, PerturbationType, list[PerturbedSpan]]:
    """Generate a surgical counterfactual mutation of `chosen_text`."""
    rng = random.Random(seed)
    all_types = [
        PerturbationType.NUMERICAL,
        PerturbationType.CODE_TOKEN_DROP,
        PerturbationType.EM_DASH_INJECTION,
        PerturbationType.SURFACE_VIOLATION,
        PerturbationType.AI_SLOP,
        PerturbationType.ENTITY_SWAP,
        PerturbationType.NEGATION,
    ]
    if target_type is not None:
        types = [target_type]
    else:
        types = list(all_types)
        rng.shuffle(types)

    for pt in types:
        if pt == PerturbationType.NUMERICAL:
            mutated, spans = perturb_numerical(chosen_text, seed=seed)
        elif pt == PerturbationType.ENTITY_SWAP:
            mutated, spans = perturb_entity(chosen_text, seed=seed)
        elif pt == PerturbationType.AI_SLOP:
            mutated, spans = perturb_slop(chosen_text, seed=seed)
        elif pt == PerturbationType.NEGATION:
            mutated, spans = perturb_negation(chosen_text, seed=seed)
        elif pt == PerturbationType.EM_DASH_INJECTION:
            mutated, spans = perturb_em_dash(chosen_text, seed=seed)
        elif pt == PerturbationType.CODE_TOKEN_DROP:
            mutated, spans = perturb_code_token_drop(chosen_text, seed=seed)
        elif pt == PerturbationType.SURFACE_VIOLATION:
            mutated, spans = perturb_surface_violation(
                chosen_text, surface_id=surface_id, seed=seed
            )
        else:
            continue

        if spans and mutated != chosen_text:
            return mutated, pt, spans

    mutated, spans = perturb_slop(chosen_text, seed=seed)
    return mutated, PerturbationType.AI_SLOP, spans


class _WhitespaceFallbackTokenizer:
    """Deterministic regex tokenizer used when no HuggingFace tokenizer is passed."""

    is_fast = False

    _TOK_RE = re.compile(r"\s+|\w+|[^\w\s]")

    def __init__(self) -> None:
        self._vocab: dict[str, int] = {}
        self._id_to_tok: dict[int, str] = {}

    def encode(self, text: str, add_special_tokens: bool = False) -> list[int]:
        tokens = self._TOK_RE.findall(text)
        ids: list[int] = []
        for t in tokens:
            if t not in self._vocab:
                idx = len(self._vocab) + 1
                self._vocab[t] = idx
                self._id_to_tok[idx] = t
            ids.append(self._vocab[t])
        return ids

    def decode(self, token_ids: Sequence[int]) -> str:
        return "".join(self._id_to_tok.get(i, "") for i in token_ids)


def align_spans_to_token_mask(
    tokenizer: Any | None,
    text: str,
    spans: Sequence[PerturbedSpan | dict[str, Any]],
) -> list[int]:
    """Map character-level mutation spans `[start_char, end_char)` into token binary masks `m_t in {0, 1}`."""
    tok = tokenizer if tokenizer is not None else _WhitespaceFallbackTokenizer()

    if not spans:
        encoded = tok.encode(text, add_special_tokens=False)
        return [0] * len(encoded)

    span_intervals: list[tuple[int, int]] = []
    for s in spans:
        if isinstance(s, PerturbedSpan):
            s_start, s_end = s.start_char, s.end_char
        else:
            s_start, s_end = int(s["start_char"]), int(s["end_char"])
        if s_end <= s_start:
            s_end = min(len(text), s_start + 1)
        span_intervals.append((s_start, s_end))

    encoding = None
    if getattr(tok, "is_fast", False) and callable(tok):
        try:
            encoding = tok(
                text, return_offsets_mapping=True, add_special_tokens=False
            )
        except Exception:
            encoding = None

    if encoding and "offset_mapping" in encoding:
        offsets = encoding["offset_mapping"]
        mask = [0] * len(offsets)
        for i, (tok_start, tok_end) in enumerate(offsets):
            if tok_start == tok_end:
                continue
            for s_start, s_end in span_intervals:
                if max(tok_start, s_start) < min(tok_end, s_end):
                    mask[i] = 1
                    break
        return mask

    tokens = tok.encode(text, add_special_tokens=False)
    mask = [0] * len(tokens)
    curr_char = 0
    for i, tok_id in enumerate(tokens):
        tok_str = tok.decode([tok_id])
        pos = text.find(tok_str, curr_char)
        if pos == -1:
            trimmed = tok_str.lstrip()
            pos = text.find(trimmed, curr_char) if trimmed else curr_char
            if pos == -1:
                pos = curr_char
            tok_len = len(trimmed)
        else:
            tok_len = len(tok_str)

        tok_start = pos
        tok_end = pos + max(1, tok_len)
        curr_char = pos + tok_len

        for s_start, s_end in span_intervals:
            if max(tok_start, s_start) < min(tok_end, s_end):
                mask[i] = 1
                break

    return mask


def inject_reverse_slop(
    clean_target: str,
    surface_id: str = "general",
    task: str = "deslop",
    seed: int | None = None,
) -> str:
    """Deterministically inject AI buzzwords, em dashes, passive filler, or banned openers into clean prose to produce a realistic `<source>` (`user`) draft.

    Guarantees 100% preservation of all unit-bound numbers, backtick code spans, URLs, and CLI flags from `clean_target`.
    """
    rng = random.Random(seed)
    catalog = load_surface_catalog()
    profile = catalog.get(surface_id)
    em_dash = "\u2014"

    if surface_id == "ide_git_commit" or task == "polish_commit":
        # Turn clean commit into a realistic sloppy commit (past tense, filler, trailing period)
        lines = clean_target.splitlines()
        if not lines:
            return clean_target
        subject = lines[0]
        sloppy_prefixes = (
            "wip: seamlessly updated ",
            "misc fixes: leveraged changes to ",
            "minor changes: holistically updated ",
            "updated stuff: ",
        )
        sloppy_subj = re.sub(
            r"^([a-z]+(?:\([^)]+\))?!?:\s*)(add|fix|remove|update|use|drop|enforce|prevent|keep|cut|support|enable|split|flag|replace|darken|mark|stop|allow|detect|pin|merge|tag|move|simplify|clean|expose|wire|build)\b",
            lambda m: f"{m.group(1)}{rng.choice(['seamlessly ', 'holistically ', 'pivotal update to '])}{m.group(2)}ed",
            subject,
            flags=re.IGNORECASE,
        )
        if sloppy_subj == subject:
            sloppy_subj = f"{rng.choice(sloppy_prefixes)}{subject}"
        if not sloppy_subj.endswith("."):
            sloppy_subj += "."
        rest = "\n".join(lines[1:])
        return f"{sloppy_subj}\n{rest}".strip()

    if surface_id == "ide_code_comment" or task == "polish_comment":
        comment_intros = (
            f"This function seamlessly leverages internal state {em_dash} ",
            f"Helper method to holistically handle this step {em_dash} ",
            f"Note that in order to unlock clean execution {em_dash} ",
            f"This function is designed to seamlessly coordinate {em_dash} ",
            f"Helper method to delve into the logic here: ",
            f"Basically, this block leverages the runtime in order to ensure: ",
            f"Furthermore, it is worth noting that ",
            f"This function smoothly orchestrates behavior: ",
        )
        return f"{rng.choice(comment_intros)}{clean_target}"

    current = clean_target
    ignored = ignored_prose_ranges(current)

    # 1. Replace plain words with slop terms outside code spans
    reverse_map = [
        (r"\buse\b", "leverage"),
        (r"\buses\b", "leverages"),
        (r"\busing\b", "leveraging"),
        (r"\bexplore\b", "delve into"),
        (r"\bsmooth\b", "seamless"),
        (r"\bkey\b", "pivotal"),
        (r"\bmodern\b", "cutting-edge"),
        (r"\bnew\b", "next-generation"),
        (r"\bcomplete\b", "holistic"),
        (r"\bmodel\b", "paradigm"),
        (r"\benable\b", "unlock"),
        (r"\bsupport\b", "foster"),
        (r"\bhighlight\b", "underscore"),
        (r"\bto\b", "in order to"),
    ]
    replacements_made = 0
    for pat_str, slop_word in reverse_map:
        if replacements_made >= 3:
            break
        pat = re.compile(pat_str)
        m = pat.search(current)
        if m and not overlaps_ignored_ranges(m.start(), m.end(), ignored):
            current = current[: m.start()] + slop_word + current[m.end() :]
            ignored = ignored_prose_ranges(current)
            replacements_made += 1

    # 2. Inject an em dash in place of a comma outside code spans
    comma_matches = [
        m
        for m in re.finditer(r",\s+", current)
        if not overlaps_ignored_ranges(m.start(), m.end(), ignored)
    ]
    if comma_matches:
        cm = comma_matches[0]
        current = current[: cm.start()] + f" {em_dash} " + current[cm.end() :]
        ignored = ignored_prose_ranges(current)

    # 3. Prepend a surface-appropriate banned opener or AI filler intro (no numbers!)
    non_numeric_openers = [
        o for o in profile.banned_openers if not any(ch.isdigit() for ch in o)
    ]
    if non_numeric_openers:
        opener = rng.choice(non_numeric_openers)
        prefix = f"{opener.capitalize()}, in today's rapidly evolving landscape {em_dash} "
    elif task == "shorten":
        prefix = (
            "At this point in time, it is important to note that we are reaching out in order to share that "
        )
    else:
        fillers = [
            f"In today's rapidly evolving landscape {em_dash} it is not just an update, it is a pivotal milestone. ",
            f"Furthermore, to delve into the holistic tapestry of this work {em_dash} ",
            f"It is important to note that we can seamlessly leverage these findings {em_dash} ",
        ]
        prefix = rng.choice(fillers)

    candidate_source = prefix + current
    return candidate_source
