use std::collections::{HashMap, VecDeque};

use serde::{Deserialize, Serialize};

use crate::harper::{HarperDiagnostic, HarperEngine};

/// Metadata for a single paragraph slice in a document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParagraphSpan {
    pub index: usize,
    pub byte_start: usize,
    pub byte_end: usize,
    pub char_start: usize,
    pub char_end: usize,
    pub hash: u64,
}

/// Cache hit/miss statistics returned alongside Tier 0 diagnostics.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParagraphCacheStats {
    pub paragraphs_total: usize,
    pub cache_hits: usize,
    pub cache_misses: usize,
}

/// Compute a deterministic 64-bit FNV-1a hash (identical across native and wasm32).
pub fn fnv1a_64(bytes: &[u8]) -> u64 {
    const OFFSET_BASIS: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x00000100000001b3;
    let mut hash = OFFSET_BASIS;
    for &b in bytes {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}

/// Split `text` into paragraph blocks on blank-line boundaries while keeping fenced code blocks intact.
pub fn split_paragraphs(text: &str) -> Vec<ParagraphSpan> {
    if text.is_empty() {
        return Vec::new();
    }

    let mut spans = Vec::new();
    let mut in_fence = false;
    let mut fence_marker: Option<&str> = None;

    let mut block_byte_start: Option<usize> = None;
    let mut block_char_start = 0usize;
    let mut block_byte_end = 0usize;
    let mut block_char_end = 0usize;

    let mut byte_cursor = 0usize;
    let mut char_cursor = 0usize;

    for line in text.split_inclusive('\n') {
        let line_bytes = line.len();
        let line_chars = line.chars().count();
        let trimmed = line.trim();

        if let Some(marker) = fence_marker {
            if trimmed.starts_with(marker) {
                in_fence = false;
                fence_marker = None;
            }
        } else if trimmed.starts_with("```") {
            in_fence = true;
            fence_marker = Some("```");
        } else if trimmed.starts_with("~~~") {
            in_fence = true;
            fence_marker = Some("~~~");
        }

        if !in_fence && trimmed.is_empty() {
            if let Some(b_start) = block_byte_start.take() {
                let slice = &text[b_start..block_byte_end];
                spans.push(ParagraphSpan {
                    index: spans.len(),
                    byte_start: b_start,
                    byte_end: block_byte_end,
                    char_start: block_char_start,
                    char_end: block_char_end,
                    hash: fnv1a_64(slice.as_bytes()),
                });
            }
        } else {
            if block_byte_start.is_none() {
                block_byte_start = Some(byte_cursor);
                block_char_start = char_cursor;
            }
            block_byte_end = byte_cursor + line_bytes;
            block_char_end = char_cursor + line_chars;
        }

        byte_cursor += line_bytes;
        char_cursor += line_chars;
    }

    if let Some(b_start) = block_byte_start {
        let slice = &text[b_start..block_byte_end];
        spans.push(ParagraphSpan {
            index: spans.len(),
            byte_start: b_start,
            byte_end: block_byte_end,
            char_start: block_char_start,
            char_end: block_char_end,
            hash: fnv1a_64(slice.as_bytes()),
        });
    }

    spans
}

/// Bounded paragraph-hash cache for Harper diagnostics so long documents only re-lint edited paragraphs.
#[derive(Debug)]
pub struct ParagraphLintCache {
    max_entries: usize,
    entries: HashMap<(u64, u64), Vec<HarperDiagnostic>>,
    order: VecDeque<(u64, u64)>,
}

impl Default for ParagraphLintCache {
    fn default() -> Self {
        Self::new(512)
    }
}

impl ParagraphLintCache {
    /// Create a cache holding up to `max_entries` hashed paragraphs.
    pub fn new(max_entries: usize) -> Self {
        let cap = max_entries.max(16);
        Self {
            max_entries: cap,
            entries: HashMap::with_capacity(cap.min(256)),
            order: VecDeque::with_capacity(cap.min(256)),
        }
    }

    /// Clear all cached paragraph entries.
    pub fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
    }

    /// Return the current number of cached paragraph entries.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Return true when the cache has no entries.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Lint `text` paragraph-by-paragraph using `engine`, reusing cached diagnostics for unchanged paragraphs.
    /// For code/markup parsers that depend on whole-file AST state (e.g. Rust/Python/HTML/TeX),
    /// falls back cleanly to a single whole-document hash entry so parser context stays exact.
    pub fn check_harper(
        &mut self,
        engine: &mut HarperEngine,
        text: &str,
        language: &str,
        config_fingerprint: u64,
    ) -> (Vec<HarperDiagnostic>, ParagraphCacheStats) {
        if text.trim().is_empty() {
            return (Vec::new(), ParagraphCacheStats::default());
        }

        // Only plain English and Markdown paragraphs are safely independent across blank lines.
        let normalized_lang = language.trim().to_ascii_lowercase();
        let paragraph_safe = matches!(
            normalized_lang.as_str(),
            "" | "plaintext" | "plain" | "text" | "markdown" | "md" | "mdx"
        );

        if !paragraph_safe {
            let doc_hash = fnv1a_64(text.as_bytes());
            let key = (config_fingerprint, doc_hash);
            if let Some(cached) = self.entries.get(&key) {
                return (
                    cached.clone(),
                    ParagraphCacheStats {
                        paragraphs_total: 1,
                        cache_hits: 1,
                        cache_misses: 0,
                    },
                );
            }
            let diags = engine.check_text_with_language(text, language);
            self.insert(key, diags.clone());
            return (
                diags,
                ParagraphCacheStats {
                    paragraphs_total: 1,
                    cache_hits: 0,
                    cache_misses: 1,
                },
            );
        }

        let paragraphs = split_paragraphs(text);
        if paragraphs.is_empty() {
            return (Vec::new(), ParagraphCacheStats::default());
        }

        let mut out = Vec::new();
        let mut cache_hits = 0usize;
        let mut cache_misses = 0usize;

        for para in &paragraphs {
            let key = (config_fingerprint, para.hash);
            if let Some(cached) = self.entries.get(&key) {
                cache_hits += 1;
                rebase_diagnostics(cached, para.char_start, &mut out);
            } else {
                cache_misses += 1;
                let slice = &text[para.byte_start..para.byte_end];
                let local_diags = engine.check_text_with_language(slice, language);
                rebase_diagnostics(&local_diags, para.char_start, &mut out);
                self.insert(key, local_diags);
            }
        }

        out.sort_by_key(|d| (d.start, d.end));
        (
            out,
            ParagraphCacheStats {
                paragraphs_total: paragraphs.len(),
                cache_hits,
                cache_misses,
            },
        )
    }

    fn insert(&mut self, key: (u64, u64), value: Vec<HarperDiagnostic>) {
        if let std::collections::hash_map::Entry::Occupied(mut entry) = self.entries.entry(key) {
            entry.insert(value);
            return;
        }
        while self.entries.len() >= self.max_entries {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            } else {
                break;
            }
        }
        self.order.push_back(key);
        self.entries.insert(key, value);
    }
}

fn rebase_diagnostics(
    local: &[HarperDiagnostic],
    char_offset: usize,
    out: &mut Vec<HarperDiagnostic>,
) {
    out.reserve(local.len());
    for diag in local {
        out.push(HarperDiagnostic {
            rule: diag.rule.clone(),
            lint_kind: diag.lint_kind.clone(),
            message: diag.message.clone(),
            problem_text: diag.problem_text.clone(),
            start: diag.start + char_offset,
            end: diag.end + char_offset,
            suggestions: diag.suggestions.clone(),
        });
    }
}
