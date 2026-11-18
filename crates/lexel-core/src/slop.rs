use std::collections::BTreeMap;
use std::sync::OnceLock;

use aho_corasick::{AhoCorasick, AhoCorasickBuilder, MatchKind};
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::CoreError;

const SLOP_JSON: &str = include_str!("../../../rules/slop_terms.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SlopFile {
    em_dash_forbidden: bool,
    slop_terms: Vec<String>,
    #[serde(default)]
    safe_replacements: BTreeMap<String, String>,
}

/// Deterministic match for an AI slop phrase or em dash.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SlopHit {
    pub term: String,
    pub start: usize,
    pub end: usize,
    pub is_em_dash: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
}

/// Parse an optional `term => replacement` custom slop entry into `(term, Option<replacement>)`.
pub fn parse_custom_slop_entry(raw: &str) -> (&str, Option<&str>) {
    if let Some((term, repl)) = raw.split_once("=>") {
        (term.trim(), Some(repl.trim()))
    } else {
        (raw.trim(), None)
    }
}

/// Compute byte ranges for Markdown fenced code blocks, inline backticks, and `> ` quote lines
/// so prose/surface scanners do not emit false positives inside code or quoted replies.
pub fn ignored_prose_ranges(text: &str) -> Vec<(usize, usize)> {
    static FENCE_RE: OnceLock<Regex> = OnceLock::new();
    static INLINE_RE: OnceLock<Regex> = OnceLock::new();
    static QUOTE_RE: OnceLock<Regex> = OnceLock::new();

    let fence_re = FENCE_RE.get_or_init(|| Regex::new(r"```[\s\S]*?```").expect("valid fence re"));
    let inline_re = INLINE_RE.get_or_init(|| Regex::new(r"`[^`\n]+`").expect("valid inline re"));
    let quote_re = QUOTE_RE.get_or_init(|| Regex::new(r"(?m)^[ \t]*>.*$").expect("valid quote re"));

    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for re in [fence_re, inline_re, quote_re] {
        for m in re.find_iter(text) {
            ranges.push((m.start(), m.end()));
        }
    }
    ranges.sort_unstable();
    ranges
}

/// Return true when `[start, end)` overlaps any ignored range.
pub fn overlaps_ignored_ranges(start: usize, end: usize, ignored: &[(usize, usize)]) -> bool {
    ignored
        .iter()
        .any(|&(ig_start, ig_end)| start < ig_end && end > ig_start)
}

/// Sub-millisecond case-insensitive Aho-Corasick anti-slop scanner backed by `rules/slop_terms.json`.
#[derive(Debug, Clone)]
pub struct SlopScanner {
    matcher: AhoCorasick,
    base_terms: Vec<String>,
    safe_replacements: BTreeMap<String, String>,
    em_dash_forbidden: bool,
}

impl SlopScanner {
    /// Build a scanner directly from the canonical `rules/slop_terms.json` file.
    pub fn load_embedded() -> Result<Self, CoreError> {
        let parsed: SlopFile = serde_json::from_str(SLOP_JSON)?;
        let matcher = build_matcher(&parsed.slop_terms)?;
        let safe_replacements = parsed
            .safe_replacements
            .into_iter()
            .map(|(k, v)| (k.trim_end().to_ascii_lowercase(), v))
            .collect();
        Ok(Self {
            matcher,
            base_terms: parsed.slop_terms,
            safe_replacements,
            em_dash_forbidden: parsed.em_dash_forbidden,
        })
    }

    /// Return safe replacements sorted longest-first for deterministic substitution.
    pub fn safe_replacements_sorted(&self) -> Vec<(String, String)> {
        let parsed: SlopFile = serde_json::from_str(SLOP_JSON).unwrap_or(SlopFile {
            em_dash_forbidden: self.em_dash_forbidden,
            slop_terms: Vec::new(),
            safe_replacements: BTreeMap::new(),
        });
        let mut pairs: Vec<(String, String)> = parsed.safe_replacements.into_iter().collect();
        pairs.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then_with(|| a.0.cmp(&b.0)));
        pairs
    }

    /// Look up a deterministic plain-English replacement for a matched slop term.
    pub fn safe_replacement_for(&self, matched: &str, custom_terms: &[String]) -> Option<String> {
        let lower = matched.trim().to_ascii_lowercase();
        for raw in custom_terms {
            let (term, repl) = parse_custom_slop_entry(raw);
            if term.eq_ignore_ascii_case(&lower)
                && let Some(r) = repl
            {
                return Some(preserve_case(matched, r));
            }
        }
        self.safe_replacements
            .get(&lower)
            .map(|r| preserve_case(matched, r))
    }

    /// Scan `text` for banned AI buzzwords and em dashes (`—` or ` -- `), skipping fenced/inline code and blockquotes.
    pub fn scan(&self, text: &str, allow_em_dashes: bool) -> Vec<SlopHit> {
        self.scan_with_matcher(&self.matcher, text, allow_em_dashes, &[])
    }

    /// Scan `text` while adding `custom_terms` and excluding `disabled_terms`.
    pub fn scan_with_overrides(
        &self,
        text: &str,
        allow_em_dashes: bool,
        custom_terms: &[String],
        disabled_terms: &[String],
    ) -> Vec<SlopHit> {
        if custom_terms.is_empty() && disabled_terms.is_empty() {
            return self.scan(text, allow_em_dashes);
        }
        let mut terms: Vec<String> = self
            .base_terms
            .iter()
            .filter(|t| !disabled_terms.iter().any(|d| d.eq_ignore_ascii_case(t)))
            .cloned()
            .collect();
        for raw in custom_terms {
            let (term, _) = parse_custom_slop_entry(raw);
            if !term.is_empty()
                && !disabled_terms.iter().any(|d| d.eq_ignore_ascii_case(term))
                && !terms.iter().any(|t| t.eq_ignore_ascii_case(term))
            {
                terms.push(term.to_owned());
            }
        }
        let Ok(matcher) = build_matcher(&terms) else {
            return Vec::new();
        };
        self.scan_with_matcher(&matcher, text, allow_em_dashes, custom_terms)
    }

    fn scan_with_matcher(
        &self,
        matcher: &AhoCorasick,
        text: &str,
        allow_em_dashes: bool,
        custom_terms: &[String],
    ) -> Vec<SlopHit> {
        let mut hits = Vec::new();
        let bytes = text.as_bytes();
        let ignored = ignored_prose_ranges(text);

        for mat in matcher.find_iter(text) {
            let start = mat.start();
            let end = mat.end();
            if overlaps_ignored_ranges(start, end, &ignored) {
                continue;
            }
            let prev_ok = start == 0 || !is_word_byte(bytes[start - 1]);
            let next_ok = end == bytes.len() || !is_word_byte(bytes[end]);
            if prev_ok && next_ok {
                let matched = &text[start..end];
                hits.push(SlopHit {
                    term: matched.to_owned(),
                    start,
                    end,
                    is_em_dash: false,
                    suggestion: self.safe_replacement_for(matched, custom_terms),
                });
            }
        }

        if self.em_dash_forbidden && !allow_em_dashes {
            for (idx, _) in text.match_indices('—') {
                let end = idx + '—'.len_utf8();
                if overlaps_ignored_ranges(idx, end, &ignored) {
                    continue;
                }
                hits.push(SlopHit {
                    term: "—".to_owned(),
                    start: idx,
                    end,
                    is_em_dash: true,
                    suggestion: Some(", ".to_owned()),
                });
            }
            for (idx, matched) in text.match_indices(" -- ") {
                let end = idx + matched.len();
                if overlaps_ignored_ranges(idx, end, &ignored) {
                    continue;
                }
                hits.push(SlopHit {
                    term: matched.to_owned(),
                    start: idx,
                    end,
                    is_em_dash: true,
                    suggestion: Some(", ".to_owned()),
                });
            }
        }

        hits.sort_by_key(|h| (h.start, h.end));
        hits
    }
}

pub(crate) fn preserve_case(matched: &str, replacement: &str) -> String {
    if replacement.is_empty() {
        return String::new();
    }
    let first_upper = matched
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_uppercase());
    if !first_upper {
        return replacement.to_owned();
    }
    let mut chars = replacement.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
        None => String::new(),
    }
}

fn build_matcher(terms: &[String]) -> Result<AhoCorasick, CoreError> {
    AhoCorasickBuilder::new()
        .ascii_case_insensitive(true)
        .match_kind(MatchKind::LeftmostLongest)
        .build(terms)
        .map_err(|err| CoreError::InvalidLintConfig(err.to_string()))
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}
