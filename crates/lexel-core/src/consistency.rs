use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::slop::{ignored_prose_ranges, overlaps_ignored_ranges, preserve_case};

/// Category of document-wide consistency violation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConsistencyKind {
    SpellingDialect,
    Hyphenation,
    ProductCasing,
    VersionFormat,
}

/// A document-wide consistency issue with a deterministic preferred form.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsistencyIssue {
    pub kind: ConsistencyKind,
    pub message: String,
    pub found: String,
    pub preferred: String,
    pub start: usize,
    pub end: usize,
    pub group_key: String,
}

/// Curated US -> UK spelling pairs (lowercase base and common inflections).
const US_UK_PAIRS: &[(&str, &str)] = &[
    ("color", "colour"),
    ("colors", "colours"),
    ("colored", "coloured"),
    ("coloring", "colouring"),
    ("behavior", "behaviour"),
    ("behaviors", "behaviours"),
    ("behavioral", "behavioural"),
    ("favor", "favour"),
    ("favors", "favours"),
    ("favorite", "favourite"),
    ("favorites", "favourites"),
    ("honor", "honour"),
    ("honors", "honours"),
    ("labor", "labour"),
    ("neighbor", "neighbour"),
    ("neighbors", "neighbours"),
    ("flavor", "flavour"),
    ("flavors", "flavours"),
    ("humor", "humour"),
    ("rumor", "rumour"),
    ("harbor", "harbour"),
    ("vapor", "vapour"),
    ("organize", "organise"),
    ("organizes", "organises"),
    ("organized", "organised"),
    ("organizing", "organising"),
    ("organization", "organisation"),
    ("organizations", "organisations"),
    ("optimize", "optimise"),
    ("optimizes", "optimises"),
    ("optimized", "optimised"),
    ("optimizing", "optimising"),
    ("optimization", "optimisation"),
    ("analyze", "analyse"),
    ("analyzes", "analyses"),
    ("analyzed", "analysed"),
    ("analyzing", "analysing"),
    ("realize", "realise"),
    ("realized", "realised"),
    ("realizing", "realising"),
    ("recognize", "recognise"),
    ("recognized", "recognised"),
    ("categorize", "categorise"),
    ("customize", "customise"),
    ("customized", "customised"),
    ("initialize", "initialise"),
    ("initialized", "initialised"),
    ("initializing", "initialising"),
    ("serialize", "serialise"),
    ("serialized", "serialised"),
    ("synchronize", "synchronise"),
    ("synchronized", "synchronised"),
    ("authorize", "authorise"),
    ("authorized", "authorised"),
    ("normalize", "normalise"),
    ("normalized", "normalised"),
    ("prioritize", "prioritise"),
    ("prioritized", "prioritised"),
    ("summarize", "summarise"),
    ("summarized", "summarised"),
    ("center", "centre"),
    ("centers", "centres"),
    ("centered", "centred"),
    ("meter", "metre"),
    ("meters", "metres"),
    ("fiber", "fibre"),
    ("theater", "theatre"),
    ("liter", "litre"),
    ("defense", "defence"),
    ("offense", "offence"),
    ("license", "licence"),
    ("catalog", "catalogue"),
    ("dialog", "dialogue"),
    ("analog", "analogue"),
    ("canceled", "cancelled"),
    ("canceling", "cancelling"),
    ("labeled", "labelled"),
    ("labeling", "labelling"),
    ("modeled", "modelled"),
    ("modeling", "modelling"),
    ("traveled", "travelled"),
    ("traveling", "travelling"),
    ("gray", "grey"),
    ("artifact", "artefact"),
    ("artifacts", "artefacts"),
    ("fulfill", "fulfil"),
    ("enroll", "enrol"),
    ("skillful", "skilful"),
    ("aging", "ageing"),
    ("judgment", "judgement"),
    ("acknowledgment", "acknowledgement"),
];

/// Curated hyphenation variant pairs `(hyphenated, closed)` or `(hyphenated, spaced)`.
const HYPHEN_PAIRS: &[(&str, &str)] = &[
    ("e-mail", "email"),
    ("e-mails", "emails"),
    ("co-operate", "cooperate"),
    ("on-boarding", "onboarding"),
    ("real-time", "realtime"),
    ("end-point", "endpoint"),
    ("end-points", "endpoints"),
    ("web-site", "website"),
    ("web-sites", "websites"),
    ("work-flow", "workflow"),
    ("work-flows", "workflows"),
    ("code-base", "codebase"),
    ("data-base", "database"),
    ("plug-in", "plugin"),
    ("plug-ins", "plugins"),
    ("set-up", "setup"),
    ("sign-up", "signup"),
    ("back-end", "backend"),
    ("front-end", "frontend"),
    ("full-stack", "fullstack"),
    ("check-out", "checkout"),
    ("drop-down", "dropdown"),
    ("run-time", "runtime"),
    ("time-out", "timeout"),
    ("time-outs", "timeouts"),
    ("trade-off", "tradeoff"),
    ("trade-offs", "tradeoffs"),
    ("roll-out", "rollout"),
    ("follow-up", "followup"),
    ("start-up", "startup"),
    ("start-ups", "startups"),
    ("life-cycle", "lifecycle"),
    ("micro-service", "microservice"),
    ("micro-services", "microservices"),
    ("open-source", "open source"),
    ("use-case", "use case"),
    ("use-cases", "use cases"),
];

/// Canonical product/brand names with non-trivial casing.
const CANONICAL_PRODUCTS: &[&str] = &[
    "GitHub",
    "GitLab",
    "JavaScript",
    "TypeScript",
    "PostgreSQL",
    "MySQL",
    "SQLite",
    "GraphQL",
    "Next.js",
    "Node.js",
    "macOS",
    "iOS",
    "iPhone",
    "iPad",
    "YouTube",
    "LinkedIn",
    "WordPress",
    "PyTorch",
    "TensorFlow",
    "OpenAI",
    "ChatGPT",
    "Cloudflare",
    "WebAssembly",
    "PowerShell",
    "FastAPI",
    "gRPC",
    "OAuth",
];

fn us_uk_lookup() -> &'static HashMap<&'static str, (bool, &'static str, &'static str)> {
    // Maps lowercase word -> (is_us, us_word, uk_word)
    static MAP: OnceLock<HashMap<&'static str, (bool, &'static str, &'static str)>> =
        OnceLock::new();
    MAP.get_or_init(|| {
        let mut map = HashMap::with_capacity(US_UK_PAIRS.len() * 2);
        for &(us, uk) in US_UK_PAIRS {
            map.insert(us, (true, us, uk));
            map.insert(uk, (false, us, uk));
        }
        map
    })
}

fn product_lookup() -> &'static HashMap<String, &'static str> {
    static MAP: OnceLock<HashMap<String, &'static str>> = OnceLock::new();
    MAP.get_or_init(|| {
        CANONICAL_PRODUCTS
            .iter()
            .map(|&name| (name.to_ascii_lowercase(), name))
            .collect()
    })
}

fn url_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)https?://[^\s)>\]]+").expect("valid url regex"))
}

fn version_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\b(v)?(\d+\.\d+(?:\.\d+)?(?:-[0-9a-zA-Z.-]+)?)\b")
            .expect("valid version regex")
    })
}

/// Scan a full document for mixed US/UK spelling, hyphenation variants, product casing, and version format drift.
/// `preferred_dialect`: optional dialect code matching `HarperEngine` (`0` = US, `1` = UK; `None` infers majority/first-seen).
pub fn scan_consistency_issues(text: &str, preferred_dialect: Option<u8>) -> Vec<ConsistencyIssue> {
    if text.trim().is_empty() {
        return Vec::new();
    }

    let mut ignored = ignored_prose_ranges(text);
    for m in url_regex().find_iter(text) {
        ignored.push((m.start(), m.end()));
    }
    ignored.sort_unstable();

    let mut issues = Vec::new();
    check_spelling_dialect(text, &ignored, preferred_dialect, &mut issues);
    check_hyphenation(text, &ignored, &mut issues);
    check_product_casing(text, &ignored, &mut issues);
    check_version_formats(text, &ignored, &mut issues);

    issues.sort_by_key(|i| (i.start, i.end));
    issues
}

fn check_spelling_dialect(
    text: &str,
    ignored: &[(usize, usize)],
    preferred_dialect: Option<u8>,
    issues: &mut Vec<ConsistencyIssue>,
) {
    let lookup = us_uk_lookup();
    let mut us_hits: Vec<(usize, usize, &str, &'static str)> = Vec::new();
    let mut uk_hits: Vec<(usize, usize, &str, &'static str)> = Vec::new();
    let mut first_is_us: Option<bool> = None;

    for (start, end, word) in iter_alpha_words(text) {
        if overlaps_ignored_ranges(start, end, ignored) {
            continue;
        }
        let lower = word.to_ascii_lowercase();
        if let Some(&(is_us, us_word, uk_word)) = lookup.get(lower.as_str()) {
            if first_is_us.is_none() {
                first_is_us = Some(is_us);
            }
            if is_us {
                us_hits.push((start, end, word, uk_word));
            } else {
                uk_hits.push((start, end, word, us_word));
            }
        }
    }

    if us_hits.is_empty() || uk_hits.is_empty() {
        return;
    }

    let prefer_us = match preferred_dialect {
        Some(0) => true,
        Some(1) => false,
        _ => {
            if us_hits.len() > uk_hits.len() {
                true
            } else if uk_hits.len() > us_hits.len() {
                false
            } else {
                first_is_us.unwrap_or(true)
            }
        }
    };

    if prefer_us {
        for (start, end, found, us_replacement) in uk_hits {
            let preferred = preserve_case(found, us_replacement);
            issues.push(ConsistencyIssue {
                kind: ConsistencyKind::SpellingDialect,
                message: format!(
                    "Mixed US and UK spelling: use \"{preferred}\" to match US spellings in this document."
                ),
                found: found.to_owned(),
                preferred: preferred.clone(),
                start,
                end,
                group_key: format!("{us_replacement}/{}", found.to_ascii_lowercase()),
            });
        }
    } else {
        for (start, end, found, uk_replacement) in us_hits {
            let preferred = preserve_case(found, uk_replacement);
            issues.push(ConsistencyIssue {
                kind: ConsistencyKind::SpellingDialect,
                message: format!(
                    "Mixed US and UK spelling: use \"{preferred}\" to match UK spellings in this document."
                ),
                found: found.to_owned(),
                preferred: preferred.clone(),
                start,
                end,
                group_key: format!("{}/{uk_replacement}", found.to_ascii_lowercase()),
            });
        }
    }
}

fn check_hyphenation(text: &str, ignored: &[(usize, usize)], issues: &mut Vec<ConsistencyIssue>) {
    // 1. Track every hyphenated token `a-b` and closed token `ab` dynamically + curated spaced pairs.
    #[derive(Default)]
    struct VariantBucket {
        variants: BTreeMap<String, Vec<(usize, usize, String)>>,
        first_seen: Option<String>,
    }

    let mut buckets: HashMap<String, VariantBucket> = HashMap::new();
    let mut curated_canonical: HashMap<&'static str, &'static str> =
        HashMap::with_capacity(HYPHEN_PAIRS.len() * 2);
    for &(hyph, other) in HYPHEN_PAIRS {
        curated_canonical.insert(hyph, other);
        curated_canonical.insert(other, other);
    }

    for (start, end, token) in iter_hyphen_tokens(text) {
        if overlaps_ignored_ranges(start, end, ignored) {
            continue;
        }
        let lower = token.to_ascii_lowercase();
        let key = if let Some(&canon) = curated_canonical.get(lower.as_str()) {
            canon.replace(' ', "")
        } else {
            let collapsed = lower.replace('-', "");
            if collapsed.len() < 4 {
                continue;
            }
            collapsed
        };

        let bucket = buckets.entry(key).or_default();
        if bucket.first_seen.is_none() {
            bucket.first_seen = Some(lower.clone());
        }
        bucket
            .variants
            .entry(lower)
            .or_default()
            .push((start, end, token.to_owned()));
    }

    // Also detect curated two-word spaced pairs like "open source" vs "open-source".
    let lower_text = text.to_ascii_lowercase();
    for &(hyph, spaced) in HYPHEN_PAIRS {
        if !spaced.contains(' ') {
            continue;
        }
        let key = spaced.replace(' ', "");
        let bytes = lower_text.as_bytes();
        for (start, _) in lower_text.match_indices(spaced) {
            let end = start + spaced.len();
            if overlaps_ignored_ranges(start, end, ignored) {
                continue;
            }
            let prev_ok = start == 0 || !bytes[start - 1].is_ascii_alphanumeric();
            let next_ok = end == bytes.len() || !bytes[end].is_ascii_alphanumeric();
            if !prev_ok || !next_ok {
                continue;
            }
            let bucket = buckets.entry(key.clone()).or_default();
            if bucket.first_seen.is_none() {
                bucket.first_seen = Some(spaced.to_owned());
            }
            bucket.variants.entry(spaced.to_owned()).or_default().push((
                start,
                end,
                text[start..end].to_owned(),
            ));
        }
        // Only keep spaced variant if the hyphenated form also occurred.
        if let Some(bucket) = buckets.get(&key)
            && !bucket.variants.contains_key(hyph)
        {
            buckets.remove(&key);
        }
    }

    for (key, bucket) in buckets {
        // Must have at least one hyphenated and one non-hyphenated form in the same document.
        let has_hyphen = bucket.variants.keys().any(|k| k.contains('-'));
        let has_non_hyphen = bucket.variants.keys().any(|k| !k.contains('-'));
        if !has_hyphen || !has_non_hyphen {
            continue;
        }

        let preferred_variant = bucket
            .variants
            .iter()
            .max_by(|(k_a, v_a), (k_b, v_b)| {
                v_a.len().cmp(&v_b.len()).then_with(|| {
                    let a_first = bucket.first_seen.as_deref() == Some(k_a.as_str());
                    let b_first = bucket.first_seen.as_deref() == Some(k_b.as_str());
                    a_first.cmp(&b_first)
                })
            })
            .map(|(k, _)| k.clone())
            .unwrap_or_default();

        for (variant, spans) in bucket.variants {
            if variant == preferred_variant {
                continue;
            }
            for (start, end, found) in spans {
                let preferred = preserve_case(&found, &preferred_variant);
                issues.push(ConsistencyIssue {
                    kind: ConsistencyKind::Hyphenation,
                    message: format!(
                        "Inconsistent hyphenation: \"{found}\" appears alongside \"{preferred}\"."
                    ),
                    found,
                    preferred,
                    start,
                    end,
                    group_key: key.clone(),
                });
            }
        }
    }
}

fn check_product_casing(
    text: &str,
    ignored: &[(usize, usize)],
    issues: &mut Vec<ConsistencyIssue>,
) {
    let lookup = product_lookup();
    let bytes = text.as_bytes();

    // Scan tokens that may contain dots (e.g. Next.js, Node.js).
    for (start, end, token) in iter_product_tokens(text) {
        if overlaps_ignored_ranges(start, end, ignored) {
            continue;
        }
        // Skip email addresses / hostnames like user@github.com
        let prev_char = start.checked_sub(1).and_then(|i| bytes.get(i)).copied();
        let next_char = bytes.get(end).copied();
        if matches!(prev_char, Some(b'@' | b'/' | b'.')) || matches!(next_char, Some(b'/')) {
            continue;
        }
        let lower = token.to_ascii_lowercase();
        if let Some(&canonical) = lookup.get(&lower)
            && token != canonical
        {
            issues.push(ConsistencyIssue {
                kind: ConsistencyKind::ProductCasing,
                message: format!(
                    "Use official product casing \"{canonical}\" instead of \"{token}\"."
                ),
                found: token.to_owned(),
                preferred: canonical.to_owned(),
                start,
                end,
                group_key: canonical.to_owned(),
            });
        }
    }
}

fn check_version_formats(
    text: &str,
    ignored: &[(usize, usize)],
    issues: &mut Vec<ConsistencyIssue>,
) {
    let bytes = text.as_bytes();
    let mut with_v: Vec<(usize, usize, String, String)> = Vec::new();
    let mut without_v: Vec<(usize, usize, String, String)> = Vec::new();
    let mut first_has_v: Option<bool> = None;

    for caps in version_regex().captures_iter(text) {
        let Some(full) = caps.get(0) else {
            continue;
        };
        let Some(num) = caps.get(2) else {
            continue;
        };
        let start = full.start();
        let end = full.end();
        if overlaps_ignored_ranges(start, end, ignored) {
            continue;
        }
        // Skip IPv4 addresses or 4-part dotted sequences (e.g. 127.0.0.1) or decimals with currency/units.
        if start > 0 && matches!(bytes[start - 1], b'$' | b'.' | b'/') {
            continue;
        }
        if start > 0 && text[..start].ends_with(['€', '£']) {
            continue;
        }
        if end < bytes.len() && matches!(bytes[end], b'.' | b'%' | b'/') {
            continue;
        }
        if has_metric_unit_suffix(&text[end..]) {
            continue;
        }
        // Skip dates like 2026.11.21 (4-digit first component).
        if num
            .as_str()
            .split('.')
            .next()
            .is_some_and(|first| first.len() == 4)
        {
            continue;
        }

        let has_v = caps.get(1).is_some();
        if first_has_v.is_none() {
            first_has_v = Some(has_v);
        }
        if has_v {
            with_v.push((
                start,
                end,
                full.as_str().to_owned(),
                num.as_str().to_owned(),
            ));
        } else {
            without_v.push((
                start,
                end,
                full.as_str().to_owned(),
                num.as_str().to_owned(),
            ));
        }
    }

    if with_v.is_empty() || without_v.is_empty() {
        return;
    }

    let prefer_v = if with_v.len() > without_v.len() {
        true
    } else if without_v.len() > with_v.len() {
        false
    } else {
        first_has_v.unwrap_or(true)
    };

    if prefer_v {
        for (start, end, found, num) in without_v {
            let preferred = format!("v{num}");
            issues.push(ConsistencyIssue {
                kind: ConsistencyKind::VersionFormat,
                message: format!(
                    "Mixed version format: use \"{preferred}\" to match \"v\"-prefixed versions in this document."
                ),
                found,
                preferred,
                start,
                end,
                group_key: "version_prefix".to_owned(),
            });
        }
    } else {
        for (start, end, found, num) in with_v {
            issues.push(ConsistencyIssue {
                kind: ConsistencyKind::VersionFormat,
                message: format!(
                    "Mixed version format: use \"{num}\" to match bare version numbers in this document."
                ),
                found,
                preferred: num,
                start,
                end,
                group_key: "version_prefix".to_owned(),
            });
        }
    }
}

fn has_metric_unit_suffix(rest: &str) -> bool {
    let trimmed = rest.trim_start_matches(' ');
    let unit: String = trimmed
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_lowercase();
    matches!(
        unit.as_str(),
        "ms" | "s"
            | "sec"
            | "secs"
            | "min"
            | "mins"
            | "hr"
            | "hrs"
            | "kb"
            | "mb"
            | "gb"
            | "tb"
            | "px"
            | "x"
            | "k"
            | "m"
            | "b"
            | "hz"
            | "khz"
            | "mhz"
            | "ghz"
    )
}

fn iter_alpha_words(text: &str) -> Vec<(usize, usize, &str)> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    for (idx, ch) in text.char_indices() {
        if ch.is_ascii_alphabetic() {
            if start.is_none() {
                start = Some(idx);
            }
        } else if let Some(s) = start.take() {
            out.push((s, idx, &text[s..idx]));
        }
    }
    if let Some(s) = start {
        out.push((s, text.len(), &text[s..]));
    }
    out
}

fn iter_hyphen_tokens(text: &str) -> Vec<(usize, usize, &str)> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    for (idx, ch) in text.char_indices() {
        if ch.is_ascii_alphabetic() || ch == '-' {
            if start.is_none() {
                start = Some(idx);
            }
        } else if let Some(s) = start.take() {
            let trimmed = text[s..idx].trim_matches('-');
            if !trimmed.is_empty() {
                let lead = text[s..idx].find(trimmed).unwrap_or(0);
                out.push((s + lead, s + lead + trimmed.len(), trimmed));
            }
        }
    }
    if let Some(s) = start {
        let trimmed = text[s..].trim_matches('-');
        if !trimmed.is_empty() {
            let lead = text[s..].find(trimmed).unwrap_or(0);
            out.push((s + lead, s + lead + trimmed.len(), trimmed));
        }
    }
    out
}

fn iter_product_tokens(text: &str) -> Vec<(usize, usize, &str)> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    for (idx, ch) in text.char_indices() {
        if ch.is_ascii_alphanumeric() || ch == '.' {
            if start.is_none() {
                start = Some(idx);
            }
        } else if let Some(s) = start.take() {
            let trimmed = text[s..idx].trim_matches('.');
            if !trimmed.is_empty() {
                let lead = text[s..idx].find(trimmed).unwrap_or(0);
                out.push((s + lead, s + lead + trimmed.len(), trimmed));
            }
        }
    }
    if let Some(s) = start {
        let trimmed = text[s..].trim_matches('.');
        if !trimmed.is_empty() {
            let lead = text[s..].find(trimmed).unwrap_or(0);
            out.push((s + lead, s + lead + trimmed.len(), trimmed));
        }
    }
    out
}
