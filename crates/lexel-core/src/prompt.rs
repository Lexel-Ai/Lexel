use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::context_scoper::{DEFAULT_THREAD_CONTEXT_MAX_TOKENS, scope_thread_context};
use crate::{AiTaskId, CoreError, SurfaceCatalog, SurfaceProfile, VoiceExample};

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
        AiTaskId::Direct => {
            "Make the message direct, crisp, and free of hedging or filler while keeping the tone respectful."
        }
        AiTaskId::Softer => {
            "Keep the core point clear and direct, but remove abrasive phrasing or sharp edges so it reads constructively."
        }
        AiTaskId::Bluf => {
            "Lead with the main ask, decision, or conclusion in the first sentence, then keep supporting context brief."
        }
        AiTaskId::NaturalEnglish => {
            "Rewrite into natural, idiomatic English that sounds like a clear human writer without stiff corporate wording."
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

/// Build the structured system/user chat messages consumed by local models using embedded defaults.
pub fn build_rewrite_messages(
    text: &str,
    task: AiTaskId,
    surface_id: &str,
    subcontext: Option<&str>,
    thread_context: Option<&str>,
    voice_examples: &[VoiceExample],
) -> Result<Vec<ChatMessage>, CoreError> {
    build_rewrite_messages_with_surfaces(
        text,
        task,
        surface_id,
        subcontext,
        thread_context,
        voice_examples,
        &[],
    )
}

/// Build the structured system/user chat messages consumed by local models, applying custom surface overrides.
pub fn build_rewrite_messages_with_surfaces(
    text: &str,
    task: AiTaskId,
    surface_id: &str,
    subcontext: Option<&str>,
    thread_context: Option<&str>,
    voice_examples: &[VoiceExample],
    custom_surfaces: &[SurfaceProfile],
) -> Result<Vec<ChatMessage>, CoreError> {
    let catalog = SurfaceCatalog::load_with_custom(custom_surfaces)?;
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
        let scoped = scope_thread_context(text, ctx, DEFAULT_THREAD_CONTEXT_MAX_TOKENS);
        if !scoped.scoped_text.is_empty() {
            user_parts.push(format!(
                "<thread_context>\n{}\n</thread_context>",
                scoped.scoped_text
            ));
        }
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

/// Build a single guided repair turn listing the exact Tier 2 gate constraints that failed on pass 1.
pub fn build_repair_messages(
    base_messages: &[ChatMessage],
    failed_draft: &str,
    failed_constraints: &[String],
) -> Vec<ChatMessage> {
    let mut messages = base_messages.to_vec();
    messages.push(ChatMessage {
        role: "assistant".to_owned(),
        content: failed_draft.trim().to_owned(),
    });
    let bullet_list = failed_constraints
        .iter()
        .take(6)
        .map(|c| format!("- {c}"))
        .collect::<Vec<_>>()
        .join("\n");
    messages.push(ChatMessage {
        role: "user".to_owned(),
        content: format!(
            "Fix these exact violations from your previous draft while preserving every fact, number, URL, `[LEXEL_REDACTED_n]` placeholder, and `code` token from <source>:\n{bullet_list}\n\nOutput ONLY the corrected text with no commentary or quotes."
        ),
    });
    messages
}

/// Build prompt messages for the "Ultra-Short" second take in 2-takes mode.
pub fn build_ultra_short_take_messages(
    text: &str,
    surface_id: &str,
    subcontext: Option<&str>,
    thread_context: Option<&str>,
    voice_examples: &[VoiceExample],
    custom_surfaces: &[SurfaceProfile],
) -> Result<Vec<ChatMessage>, CoreError> {
    let mut messages = build_rewrite_messages_with_surfaces(
        text,
        AiTaskId::Shorten,
        surface_id,
        subcontext,
        thread_context,
        voice_examples,
        custom_surfaces,
    )?;
    if let Some(sys) = messages.first_mut() {
        sys.content.push_str(
            "\n- Take style: Ultra-Short. Use the fewest words possible while keeping the core meaning and every number/code token intact.",
        );
    }
    Ok(messages)
}

/// Build prompt messages for short local ghost-text inline sentence completion (max ~24 tokens).
pub fn build_completion_messages(
    prefix: &str,
    suffix: Option<&str>,
    surface_id: &str,
    subcontext: Option<&str>,
    voice_examples: &[VoiceExample],
    custom_surfaces: &[SurfaceProfile],
) -> Result<Vec<ChatMessage>, CoreError> {
    let catalog = SurfaceCatalog::load_with_custom(custom_surfaces)?;
    let profile = catalog.get(surface_id)?;
    let selected = select_relevant_voice_examples(voice_examples, surface_id, prefix, 2);

    let mut system_lines = vec![
        "You are Lexel, an inline writing autocomplete engine.".to_owned(),
        "Rules:".to_owned(),
        "- Output ONLY the next few words (at most 1 short clause or finish the current sentence) that directly continue <prefix>.".to_owned(),
        "- Do NOT repeat any words from <prefix> or <suffix>.".to_owned(),
        "- No quotes, no explanations, no em dashes, and no AI buzzwords.".to_owned(),
        "- Do not invent numbers, metrics, URLs, or facts not implied by <prefix>.".to_owned(),
        format!("- Surface: {} ({})", profile.label, profile.id),
        format!("- Style: {}", profile.prompt_directive),
    ];

    if let Some(sub) = subcontext.map(str::trim).filter(|s| !s.is_empty()) {
        system_lines.push(format!("- Subcontext: {sub}"));
    }

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

    // Keep only the trailing window of prefix to keep KV prefill tiny (<200 tokens).
    let tail_prefix: String = prefix
        .chars()
        .rev()
        .take(600)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();

    let mut user_parts = vec![format!("<prefix>{tail_prefix}</prefix>")];
    if let Some(suf) = suffix.map(str::trim).filter(|s| !s.is_empty()) {
        let head_suffix: String = suf.chars().take(200).collect();
        user_parts.push(format!("<suffix>{head_suffix}</suffix>"));
    }

    Ok(vec![
        ChatMessage {
            role: "system".to_owned(),
            content: system_lines.join("\n"),
        },
        ChatMessage {
            role: "user".to_owned(),
            content: user_parts.join("\n"),
        },
    ])
}

/// Build prompt messages to adapt an expanded snippet template to the active surface and thread.
pub fn build_snippet_adapt_messages(
    expanded_snippet: &str,
    surface_id: &str,
    subcontext: Option<&str>,
    thread_context: Option<&str>,
    voice_examples: &[VoiceExample],
    custom_surfaces: &[SurfaceProfile],
) -> Result<Vec<ChatMessage>, CoreError> {
    let mut messages = build_rewrite_messages_with_surfaces(
        expanded_snippet,
        AiTaskId::RewriteSurface,
        surface_id,
        subcontext,
        thread_context,
        voice_examples,
        custom_surfaces,
    )?;
    if let Some(sys) = messages.first_mut() {
        sys.content.push_str(
            "\n- Adapt this snippet naturally to the platform and thread context without adding fluff or inventing facts.",
        );
    }
    Ok(messages)
}
