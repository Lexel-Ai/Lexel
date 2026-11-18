use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::{AiTaskId, CoreError, SurfaceCatalog, VoiceExample};

/// Chat message passed to a local inference backend.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

fn task_instruction(task: AiTaskId) -> &'static str {
    match task {
        AiTaskId::FixGrammarFlow => {
            "Fix grammar, spelling, and awkward phrasing with minimal edits. Keep the author voice intact."
        }
        AiTaskId::Deslop => {
            "Remove AI buzzwords, corporate padding, filler openers, and em dashes. Make every sentence direct and human."
        }
        AiTaskId::RewriteSurface => {
            "Rewrite the text to fit the target platform register and length rules naturally."
        }
        AiTaskId::Shorten => {
            "Shorten by 30 to 50 percent while preserving every key fact, number, URL, and code token."
        }
        AiTaskId::ReplyDraft => {
            "Draft a concise, grounded reply based only on the author draft/notes and the provided thread context. Do not invent facts."
        }
    }
}

fn tokenize_words(text: &str) -> HashSet<String> {
    text.to_ascii_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .filter(|w| w.len() >= 3)
        .map(str::to_owned)
        .collect()
}

/// Rank up to `limit` stored voice examples by surface match and token overlap.
pub fn select_relevant_voice_examples<'a>(
    examples: &'a [VoiceExample],
    surface_id: &str,
    source_text: &str,
    limit: usize,
) -> Vec<&'a VoiceExample> {
    let query_words = tokenize_words(source_text);
    let mut scored: Vec<(usize, i64, &'a VoiceExample)> = examples
        .iter()
        .filter(|ex| ex.surface_id == surface_id || ex.surface_id == "general")
        .map(|ex| {
            let mut score = if ex.surface_id == surface_id { 10 } else { 1 };
            let combined = format!("{} {}", ex.original, ex.rewritten);
            let ex_words = tokenize_words(&combined);
            for w in &query_words {
                if ex_words.contains(w) {
                    score += 2;
                }
            }
            (score, ex.created_at, ex)
        })
        .collect();

    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    scored
        .into_iter()
        .take(limit)
        .map(|(_, _, ex)| ex)
        .collect()
}

/// Build the structured system/user chat messages consumed by local models.
pub fn build_rewrite_messages(
    text: &str,
    task: AiTaskId,
    surface_id: &str,
    subcontext: Option<&str>,
    thread_context: Option<&str>,
    voice_examples: &[VoiceExample],
) -> Result<Vec<ChatMessage>, CoreError> {
    let catalog = SurfaceCatalog::load_embedded()?;
    let profile = catalog.get(surface_id)?;
    let selected = select_relevant_voice_examples(voice_examples, surface_id, text, 2);

    let mut system_lines = vec![
        "You are Lexel, a precise human writing editor.".to_owned(),
        "Rules:".to_owned(),
        "- Output ONLY the rewritten text. No preamble, no quotes, no explanation.".to_owned(),
        "- Preserve every number, metric, ID (#42), URL, and `code` token exactly.".to_owned(),
        "- Never use em dashes (—) or AI buzzwords (delve, tapestry, seamless, leverage, game-changer, unlock, pivotal).".to_owned(),
        format!("- Surface: {} ({})", profile.label, profile.id),
    ];

    if let Some(sub) = subcontext.map(str::trim).filter(|s| !s.is_empty()) {
        system_lines.push(format!("- Subcontext: {sub}"));
    }

    system_lines.push(format!("- Platform style: {}", profile.prompt_directive));
    system_lines.push(format!("- Max characters: {}", profile.max_chars));
    system_lines.push(format!("- Task: {}", task_instruction(task)));

    if !selected.is_empty() {
        system_lines.push("<voice_examples>".to_owned());
        for ex in selected {
            let compact = ex
                .rewritten
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            system_lines.push(format!("- {compact}"));
        }
        system_lines.push("</voice_examples>".to_owned());
    }

    let mut user_parts = Vec::new();
    if let Some(ctx) = thread_context.map(str::trim).filter(|s| !s.is_empty()) {
        let clipped: String = ctx.chars().take(1200).collect();
        user_parts.push(format!("<thread_context>\n{clipped}\n</thread_context>"));
    }
    user_parts.push(format!("<source>\n{}\n</source>", text.trim()));

    Ok(vec![
        ChatMessage {
            role: "system".to_owned(),
            content: system_lines.join("\n"),
        },
        ChatMessage {
            role: "user".to_owned(),
            content: user_parts.join("\n\n"),
        },
    ])
}
