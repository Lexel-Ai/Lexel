use std::collections::HashSet;

use serde::{Deserialize, Serialize};

/// Default thread context token budget tuned for local 0.5B/1.5B models.
pub const DEFAULT_THREAD_CONTEXT_MAX_TOKENS: usize = 300;

/// Deterministic summary of scoped thread context passed to local AI prompts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScopedContext {
    pub scoped_text: String,
    pub estimated_tokens: usize,
    pub original_tokens: usize,
    pub truncated: bool,
    pub kept_blocks: usize,
    pub total_blocks: usize,
}

/// Fast deterministic token count approximation (~4 chars/token or ~0.75 words/token, conservative max).
pub fn estimate_tokens(text: &str) -> usize {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0;
    }
    let char_est = trimmed.chars().count().div_ceil(4);
    let word_est = (trimmed.split_whitespace().count() * 4).div_ceil(3);
    char_est.max(word_est)
}

/// Deterministically trim `thread_context` to roughly `max_tokens` (default ~300) most relevant
/// to `source`, keeping the parent comment / relevant PR diff hunks in original order.
pub fn scope_thread_context(
    source: &str,
    thread_context: &str,
    max_tokens: usize,
) -> ScopedContext {
    let trimmed = thread_context.trim();
    if trimmed.is_empty() || max_tokens == 0 {
        return ScopedContext {
            scoped_text: String::new(),
            estimated_tokens: 0,
            original_tokens: 0,
            truncated: false,
            kept_blocks: 0,
            total_blocks: 0,
        };
    }

    let original_tokens = estimate_tokens(trimmed);
    let blocks = split_context_blocks(trimmed, max_tokens);
    let total_blocks = blocks.len();

    if original_tokens <= max_tokens {
        return ScopedContext {
            scoped_text: trimmed.to_owned(),
            estimated_tokens: original_tokens,
            original_tokens,
            truncated: false,
            kept_blocks: total_blocks,
            total_blocks,
        };
    }

    let source_terms = extract_weighted_terms(source);
    let block_count = blocks.len();

    let mut scored: Vec<(usize, usize, usize)> = blocks
        .iter()
        .enumerate()
        .map(|(idx, block)| {
            let score = score_block(block, idx, block_count, &source_terms);
            let toks = estimate_tokens(block);
            (idx, score, toks)
        })
        .collect();

    // Sort highest score first; on ties, prefer later (more recent) blocks.
    scored.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.cmp(&a.0)));

    let mut chosen_indices: Vec<usize> = Vec::new();
    let mut used_tokens = 0usize;

    for (idx, _score, toks) in &scored {
        if *toks == 0 {
            continue;
        }
        if used_tokens + *toks <= max_tokens {
            chosen_indices.push(*idx);
            used_tokens += *toks;
        }
    }

    // If even the highest-scoring single block exceeded max_tokens, trim that top block cleanly.
    if chosen_indices.is_empty()
        && let Some((top_idx, _, _)) = scored.first()
    {
        let clipped = clip_to_token_budget(&blocks[*top_idx], max_tokens);
        let est = estimate_tokens(&clipped);
        return ScopedContext {
            scoped_text: clipped,
            estimated_tokens: est,
            original_tokens,
            truncated: true,
            kept_blocks: 1,
            total_blocks,
        };
    }

    chosen_indices.sort_unstable();
    let kept_blocks = chosen_indices.len();
    let scoped_text = chosen_indices
        .into_iter()
        .map(|i| blocks[i].as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let estimated_tokens = estimate_tokens(&scoped_text);

    ScopedContext {
        scoped_text,
        estimated_tokens,
        original_tokens,
        truncated: true,
        kept_blocks,
        total_blocks,
    }
}

fn split_context_blocks(text: &str, max_tokens: usize) -> Vec<String> {
    let mut raw_blocks: Vec<String> = Vec::new();
    let mut current: Vec<&str> = Vec::new();

    for line in text.lines() {
        let trimmed = line.trim();
        let is_separator = trimmed.is_empty()
            || trimmed == "---"
            || trimmed.starts_with("diff --git ")
            || trimmed.starts_with("@@ ");

        if is_separator {
            if !current.is_empty() {
                raw_blocks.push(current.join("\n"));
                current.clear();
            }
            if trimmed.starts_with("diff --git ") || trimmed.starts_with("@@ ") {
                current.push(line);
            }
        } else {
            current.push(line);
        }
    }
    if !current.is_empty() {
        raw_blocks.push(current.join("\n"));
    }

    // Sub-split any giant single block so relevance scoring can still pick the right lines.
    let mut out = Vec::new();
    for block in raw_blocks {
        if estimate_tokens(&block) <= max_tokens {
            out.push(block);
            continue;
        }
        let mut chunk = String::new();
        for line in block.lines() {
            let line_toks = estimate_tokens(line);
            if !chunk.is_empty() && estimate_tokens(&chunk) + line_toks > max_tokens / 2 {
                out.push(std::mem::take(&mut chunk));
            }
            if !chunk.is_empty() {
                chunk.push('\n');
            }
            chunk.push_str(line);
        }
        if !chunk.trim().is_empty() {
            out.push(chunk);
        }
    }

    if out.is_empty() && !text.trim().is_empty() {
        out.push(text.trim().to_owned());
    }
    out
}

fn extract_weighted_terms(text: &str) -> Vec<(String, usize)> {
    let mut seen = HashSet::new();
    let mut terms = Vec::new();
    for raw in text.split(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-' && c != '#')
    {
        let lower = raw.trim_matches('-').to_ascii_lowercase();
        if lower.len() < 3 && !lower.starts_with('#') {
            continue;
        }
        if is_stopword(&lower) {
            continue;
        }
        if seen.insert(lower.clone()) {
            let weight = if lower.starts_with('#')
                || lower.contains('_')
                || lower.chars().any(|c| c.is_ascii_digit())
            {
                6
            } else {
                2
            };
            terms.push((lower, weight));
        }
    }
    terms
}

fn score_block(
    block: &str,
    idx: usize,
    total_blocks: usize,
    source_terms: &[(String, usize)],
) -> usize {
    let block_words: HashSet<String> = block
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-' && c != '#')
        .map(|w| w.trim_matches('-').to_ascii_lowercase())
        .filter(|w| w.len() >= 3 || w.starts_with('#'))
        .collect();

    let mut score = 0usize;
    for (term, weight) in source_terms {
        if block_words.contains(term) {
            score += *weight;
        }
    }

    // Prioritize the immediate parent comment / most recent block so replies stay grounded even
    // when the author's draft is brief (e.g. "Sounds good, merging now").
    if idx + 1 == total_blocks {
        score += 5;
    } else if idx + 2 == total_blocks {
        score += 2;
    }

    // Slight boost for code diff hunks or direct questions.
    if block.contains('?') {
        score += 2;
    }
    if block.starts_with("@@ ") || block.contains("```") {
        score += 2;
    }

    score
}

fn clip_to_token_budget(text: &str, max_tokens: usize) -> String {
    let char_cap = max_tokens.saturating_mul(4);
    let mut out = String::new();
    for word in text.split_whitespace() {
        let next_len = if out.is_empty() {
            word.len()
        } else {
            out.len() + 1 + word.len()
        };
        if next_len > char_cap || estimate_tokens(&out) >= max_tokens {
            break;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    if out.is_empty() {
        text.chars().take(char_cap).collect()
    } else {
        out
    }
}

fn is_stopword(word: &str) -> bool {
    matches!(
        word,
        "the"
            | "and"
            | "for"
            | "that"
            | "this"
            | "with"
            | "from"
            | "have"
            | "your"
            | "you"
            | "are"
            | "was"
            | "were"
            | "will"
            | "would"
            | "could"
            | "should"
            | "about"
            | "into"
            | "just"
            | "been"
            | "they"
            | "them"
            | "their"
            | "what"
            | "when"
            | "where"
            | "which"
            | "there"
            | "here"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_short_context_verbatim() {
        let ctx = "Alice: Can we merge PR #42 after fixing the cache timeout?";
        let scoped = scope_thread_context("Yes, merging #42 now.", ctx, 300);
        assert!(!scoped.truncated);
        assert_eq!(scoped.scoped_text, ctx);
    }

    #[test]
    fn selects_relevant_blocks_within_budget_in_order() {
        let mut long_thread = Vec::new();
        for i in 0..12 {
            long_thread.push(format!(
                "Comment {i}: Unrelated discussion about office lunch menus, calendar scheduling, and quarterly seating plans across building {i} with extra filler details to consume token budget."
            ));
        }
        long_thread[4] = "Comment 4: In `cache_store.rs`, `evict_stale_entries` drops keys early when TTL is under 30s on PR #88.".to_owned();
        long_thread[11] =
            "Comment 11: Can you confirm whether #88 fixes the eviction race?".to_owned();
        let joined = long_thread.join("\n\n");

        let scoped = scope_thread_context(
            "Updated `evict_stale_entries` in #88 so keys stay valid until TTL expires.",
            &joined,
            120,
        );
        assert!(scoped.truncated);
        assert!(scoped.estimated_tokens <= 120);
        assert!(scoped.scoped_text.contains("evict_stale_entries"));
        assert!(scoped.scoped_text.contains("eviction race"));
        let pos_4 = scoped.scoped_text.find("Comment 4").unwrap();
        let pos_11 = scoped.scoped_text.find("Comment 11").unwrap();
        assert!(pos_4 < pos_11);
    }
}
