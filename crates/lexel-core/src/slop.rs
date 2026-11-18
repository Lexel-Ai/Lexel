use aho_corasick::{AhoCorasick, AhoCorasickBuilder, MatchKind};
use serde::{Deserialize, Serialize};

use crate::CoreError;

const SLOP_JSON: &str = include_str!("../../../rules/slop_terms.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SlopFile {
    em_dash_forbidden: bool,
    slop_terms: Vec<String>,
}

/// Deterministic match for an AI slop phrase or em dash.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SlopHit {
    pub term: String,
    pub start: usize,
    pub end: usize,
    pub is_em_dash: bool,
}

/// Sub-millisecond case-insensitive Aho-Corasick anti-slop scanner backed by `rules/slop_terms.json`.
#[derive(Debug, Clone)]
pub struct SlopScanner {
    matcher: AhoCorasick,
    base_terms: Vec<String>,
    em_dash_forbidden: bool,
}

impl SlopScanner {
    /// Build a scanner directly from the canonical `rules/slop_terms.json` file.
    pub fn load_embedded() -> Result<Self, CoreError> {
        let parsed: SlopFile = serde_json::from_str(SLOP_JSON)?;
        let matcher = build_matcher(&parsed.slop_terms)?;
        Ok(Self {
            matcher,
            base_terms: parsed.slop_terms,
            em_dash_forbidden: parsed.em_dash_forbidden,
        })
    }

    /// Scan `text` for banned AI buzzwords and em dashes (`—` or ` -- `).
    pub fn scan(&self, text: &str, allow_em_dashes: bool) -> Vec<SlopHit> {
        self.scan_with_matcher(&self.matcher, text, allow_em_dashes)
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
        for term in custom_terms {
            let trimmed = term.trim();
            if !trimmed.is_empty()
                && !disabled_terms
                    .iter()
                    .any(|d| d.eq_ignore_ascii_case(trimmed))
                && !terms.iter().any(|t| t.eq_ignore_ascii_case(trimmed))
            {
                terms.push(trimmed.to_owned());
            }
        }
        let Ok(matcher) = build_matcher(&terms) else {
            return Vec::new();
        };
        self.scan_with_matcher(&matcher, text, allow_em_dashes)
    }

    fn scan_with_matcher(
        &self,
        matcher: &AhoCorasick,
        text: &str,
        allow_em_dashes: bool,
    ) -> Vec<SlopHit> {
        let mut hits = Vec::new();
        let bytes = text.as_bytes();

        for mat in matcher.find_iter(text) {
            let start = mat.start();
            let end = mat.end();
            let prev_ok = start == 0 || !is_word_byte(bytes[start - 1]);
            let next_ok = end == bytes.len() || !is_word_byte(bytes[end]);
            if prev_ok && next_ok {
                hits.push(SlopHit {
                    term: text[start..end].to_owned(),
                    start,
                    end,
                    is_em_dash: false,
                });
            }
        }

        if self.em_dash_forbidden && !allow_em_dashes {
            for (idx, _) in text.match_indices('—') {
                hits.push(SlopHit {
                    term: "—".to_owned(),
                    start: idx,
                    end: idx + '—'.len_utf8(),
                    is_em_dash: true,
                });
            }
            for (idx, matched) in text.match_indices(" -- ") {
                hits.push(SlopHit {
                    term: matched.to_owned(),
                    start: idx,
                    end: idx + matched.len(),
                    is_em_dash: true,
                });
            }
        }

        hits.sort_by_key(|h| (h.start, h.end));
        hits
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
