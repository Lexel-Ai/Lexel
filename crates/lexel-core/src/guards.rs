use std::sync::OnceLock;

use aho_corasick::{AhoCorasick, AhoCorasickBuilder, MatchKind};
use serde::{Deserialize, Serialize};

use crate::slop::{
    ignored_prose_ranges, overlaps_ignored_ranges, parse_custom_slop_entry, preserve_case,
};

/// Category of deterministic Tier 0 writing guard alert.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WritingGuardKind {
    WallOfText,
    BuriedAsk,
    AbrasiveTone,
    MissingAttachment,
    CrutchWord,
}

/// Severity of a writing guard hit.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WritingGuardSeverity {
    Info,
    Warning,
}

/// A deterministic writing guard warning (BLUF, wall of text, regret shield, or crutch word).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WritingGuardHit {
    pub kind: WritingGuardKind,
    pub severity: WritingGuardSeverity,
    pub rule_id: String,
    pub message: String,
    pub matched_text: String,
    pub start: usize,
    pub end: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quick_action: Option<String>,
}

/// Return true for surfaces where BLUF ("put the ask first") and wall-of-text checks apply.
pub fn is_bluf_surface(surface_id: &str) -> bool {
    matches!(
        surface_id,
        "web_email" | "web_discord_slack" | "web_github_pr" | "email" | "slack" | "github_pr"
    )
}

struct AbrasiveRule {
    phrase: &'static str,
    message: &'static str,
    suggestion: Option<&'static str>,
}

const ABRASIVE_RULES: &[AbrasiveRule] = &[
    AbrasiveRule {
        phrase: "as i already said",
        message: "Sounds impatient. Recap neutrally instead.",
        suggestion: Some("To recap"),
    },
    AbrasiveRule {
        phrase: "as i mentioned before",
        message: "Sounds curt. Reference the earlier point neutrally.",
        suggestion: Some("Following up on the earlier point"),
    },
    AbrasiveRule {
        phrase: "as i've already explained",
        message: "Can read as dismissive. Restate the key detail directly.",
        suggestion: Some("To summarize"),
    },
    AbrasiveRule {
        phrase: "as previously stated",
        message: "Stiff and passive-aggressive. State the point plainly.",
        suggestion: Some("To recap"),
    },
    AbrasiveRule {
        phrase: "per my last email",
        message: "Often reads as passive-aggressive. Point to the decision directly.",
        suggestion: Some("Following up on my earlier note"),
    },
    AbrasiveRule {
        phrase: "per my previous email",
        message: "Often reads as passive-aggressive. Point to the decision directly.",
        suggestion: Some("Following up on my earlier note"),
    },
    AbrasiveRule {
        phrase: "why didn't you",
        message: "Accusatory phrasing. Ask about the tradeoff or blocker instead.",
        suggestion: Some("Could we check whether"),
    },
    AbrasiveRule {
        phrase: "why did you not",
        message: "Accusatory phrasing. Ask about the tradeoff or blocker instead.",
        suggestion: Some("Could we check whether"),
    },
    AbrasiveRule {
        phrase: "why haven't you",
        message: "Sounds confrontational. Ask for a status update directly.",
        suggestion: Some("What is the status on"),
    },
    AbrasiveRule {
        phrase: "obviously",
        message: "\"Obviously\" can sound condescending to readers. Drop it and state the fact.",
        suggestion: Some(""),
    },
    AbrasiveRule {
        phrase: "you clearly didn't",
        message: "Reads as an accusation. Describe the missing step neutrally.",
        suggestion: Some("It looks like we still need to"),
    },
    AbrasiveRule {
        phrase: "you failed to",
        message: "Blame-focused phrasing. State what is missing instead.",
        suggestion: Some("This is missing"),
    },
    AbrasiveRule {
        phrase: "this makes no sense",
        message: "Dismissive in reviews or chat. Name the specific confusion.",
        suggestion: Some("I am having trouble following this part"),
    },
    AbrasiveRule {
        phrase: "that makes no sense",
        message: "Dismissive in reviews or chat. Name the specific confusion.",
        suggestion: Some("I am having trouble following that"),
    },
    AbrasiveRule {
        phrase: "did you even read",
        message: "Abrasive phrasing. Point directly to the section that matters.",
        suggestion: Some("Could you take a look at"),
    },
    AbrasiveRule {
        phrase: "did you even test",
        message: "Abrasive phrasing in reviews. Ask which test cases ran.",
        suggestion: Some("Which test cases did you run for"),
    },
    AbrasiveRule {
        phrase: "it's not that hard",
        message: "Condescending phrasing. Offer the concrete step instead.",
        suggestion: Some("Here is a quick way to handle it"),
    },
    AbrasiveRule {
        phrase: "it is not that hard",
        message: "Condescending phrasing. Offer the concrete step instead.",
        suggestion: Some("Here is a quick way to handle it"),
    },
    AbrasiveRule {
        phrase: "please read carefully",
        message: "Can sound lecturing. Highlight the exact requirement instead.",
        suggestion: Some("Please note"),
    },
    AbrasiveRule {
        phrase: "just read the",
        message: "Sounds dismissive. Link or quote the relevant section directly.",
        suggestion: Some("Check the"),
    },
    AbrasiveRule {
        phrase: "rtfm",
        message: "Hostile shorthand. Share the relevant doc link directly.",
        suggestion: Some("check the documentation"),
    },
];

const ATTACHMENT_PHRASES: &[&str] = &[
    "see attached",
    "attached is",
    "attached are",
    "attached please find",
    "please find attached",
    "i've attached",
    "i have attached",
    "i attached",
    "attached the",
    "attached my",
    "in the attachment",
    "attachment below",
    "find the attached",
];

const ASK_SIGNALS: &[&str] = &[
    "could you",
    "can you",
    "would you",
    "please review",
    "please approve",
    "please confirm",
    "please send",
    "please share",
    "please let me know",
    "let me know if",
    "need your approval",
    "need your feedback",
    "need your sign-off",
    "looking for feedback",
    "action needed",
    "action required",
];

fn abrasive_matcher() -> &'static AhoCorasick {
    static MATCHER: OnceLock<AhoCorasick> = OnceLock::new();
    MATCHER.get_or_init(|| {
        let patterns: Vec<&str> = ABRASIVE_RULES.iter().map(|r| r.phrase).collect();
        AhoCorasickBuilder::new()
            .ascii_case_insensitive(true)
            .match_kind(MatchKind::LeftmostLongest)
            .build(patterns)
            .expect("static abrasive rules must compile")
    })
}

fn attachment_matcher() -> &'static AhoCorasick {
    static MATCHER: OnceLock<AhoCorasick> = OnceLock::new();
    MATCHER.get_or_init(|| {
        AhoCorasickBuilder::new()
            .ascii_case_insensitive(true)
            .match_kind(MatchKind::LeftmostLongest)
            .build(ATTACHMENT_PHRASES)
            .expect("static attachment phrases must compile")
    })
}

fn ask_signal_matcher() -> &'static AhoCorasick {
    static MATCHER: OnceLock<AhoCorasick> = OnceLock::new();
    MATCHER.get_or_init(|| {
        AhoCorasickBuilder::new()
            .ascii_case_insensitive(true)
            .match_kind(MatchKind::LeftmostLongest)
            .build(ASK_SIGNALS)
            .expect("static ask signals must compile")
    })
}

/// Run all Tier 0 writing guards: BLUF / wall-of-text, regret shield, and personal crutch-word bans.
pub fn scan_writing_guards(
    text: &str,
    surface_id: &str,
    crutch_words: &[String],
    has_attachment_signal: bool,
) -> Vec<WritingGuardHit> {
    let mut hits = scan_bluf_and_walls(text, surface_id);
    hits.extend(scan_regret_shield(text, has_attachment_signal));
    hits.extend(scan_crutch_words(text, crutch_words));
    hits.sort_by_key(|h| (h.start, h.end));
    hits
}

/// Flag 6+ line walls of text and buried asks on Email, Slack/Chat, and GitHub PR surfaces.
pub fn scan_bluf_and_walls(text: &str, surface_id: &str) -> Vec<WritingGuardHit> {
    if text.trim().is_empty() || !is_bluf_surface(surface_id) {
        return Vec::new();
    }

    let ignored = ignored_prose_ranges(text);
    let mut hits = Vec::new();

    // 1. Wall-of-text detection: paragraph blocks spanning >= 6 physical or wrapped prose lines.
    for (p_start, p_end) in split_prose_blocks(text, &ignored) {
        let block = &text[p_start..p_end];
        let lines: Vec<&str> = block
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        if lines.is_empty() {
            continue;
        }
        // Structured bullet/numbered lists are already scannable; do not flag them as a wall.
        let list_lines = lines.iter().filter(|l| is_list_line(l)).count();
        if list_lines * 2 >= lines.len() && list_lines >= 2 {
            continue;
        }

        let estimated_lines: usize = lines
            .iter()
            .map(|l| l.chars().count().div_ceil(80).max(1))
            .sum();
        let word_count = block.split_whitespace().count();

        if estimated_lines >= 6 || (lines.len() >= 6 && word_count >= 55) {
            let surface_name = surface_display_name(surface_id);
            hits.push(WritingGuardHit {
                kind: WritingGuardKind::WallOfText,
                severity: WritingGuardSeverity::Warning,
                rule_id: "wall_of_text".to_owned(),
                message: format!(
                    "Wall of text (about {estimated_lines} lines) for {surface_name}. Split into short paragraphs or bullets."
                ),
                matched_text: truncate_chars(block, 80),
                start: p_start,
                end: p_end,
                suggestion: None,
                quick_action: Some("lead_with_ask".to_owned()),
            });
        }
    }

    // 2. Buried ask detection (BLUF): substantial draft where the request/question only appears late.
    let trimmed = text.trim();
    let total_chars = trimmed.chars().count();
    let total_words = trimmed.split_whitespace().count();
    if total_chars >= 260 && total_words >= 45 {
        let ask_spans = find_ask_sentences(text, &ignored);
        if !ask_spans.is_empty() {
            let lead_cutoff = (text.len() as f64 * 0.35) as usize;
            let has_early_ask = ask_spans.iter().any(|&(s, _)| s <= lead_cutoff);
            let late_cutoff = (text.len() as f64 * 0.55) as usize;
            if !has_early_ask
                && let Some(&(ask_start, ask_end)) =
                    ask_spans.iter().find(|&&(s, _)| s >= late_cutoff)
            {
                hits.push(WritingGuardHit {
                    kind: WritingGuardKind::BuriedAsk,
                    severity: WritingGuardSeverity::Info,
                    rule_id: "buried_ask".to_owned(),
                    message:
                        "Main ask is buried near the end. Move the question or request to the top."
                            .to_owned(),
                    matched_text: text[ask_start..ask_end].trim().to_owned(),
                    start: ask_start,
                    end: ask_end,
                    suggestion: None,
                    quick_action: Some("lead_with_ask".to_owned()),
                });
            }
        }
    }

    hits.sort_by_key(|h| (h.start, h.end));
    hits
}

/// Detect abrasive phrasing and "see attached" promises without an attachment signal.
pub fn scan_regret_shield(text: &str, has_attachment_signal: bool) -> Vec<WritingGuardHit> {
    if text.trim().is_empty() {
        return Vec::new();
    }

    let ignored = ignored_prose_ranges(text);
    let bytes = text.as_bytes();
    let mut hits = Vec::new();

    for m in abrasive_matcher().find_iter(text) {
        let start = m.start();
        let end = m.end();
        if overlaps_ignored_ranges(start, end, &ignored) {
            continue;
        }
        let prev_ok = start == 0 || !is_word_byte(bytes[start - 1]);
        let next_ok = end == bytes.len() || !is_word_byte(bytes[end]);
        if !prev_ok || !next_ok {
            continue;
        }
        let rule = &ABRASIVE_RULES[m.pattern().as_usize()];
        let matched = &text[start..end];
        let suggestion = rule.suggestion.map(|s| {
            if s.is_empty() {
                String::new()
            } else {
                preserve_case(matched, s)
            }
        });
        hits.push(WritingGuardHit {
            kind: WritingGuardKind::AbrasiveTone,
            severity: WritingGuardSeverity::Warning,
            rule_id: "regret_abrasive".to_owned(),
            message: rule.message.to_owned(),
            matched_text: matched.to_owned(),
            start,
            end,
            suggestion,
            quick_action: Some("soften_edge".to_owned()),
        });
    }

    if !has_attachment_signal {
        for m in attachment_matcher().find_iter(text) {
            let start = m.start();
            let end = m.end();
            if overlaps_ignored_ranges(start, end, &ignored) {
                continue;
            }
            let prev_ok = start == 0 || !is_word_byte(bytes[start - 1]);
            let next_ok = end == bytes.len() || !is_word_byte(bytes[end]);
            if !prev_ok || !next_ok {
                continue;
            }
            hits.push(WritingGuardHit {
                kind: WritingGuardKind::MissingAttachment,
                severity: WritingGuardSeverity::Warning,
                rule_id: "regret_missing_attachment".to_owned(),
                message: "Mentions an attachment, but no attached file was detected.".to_owned(),
                matched_text: text[start..end].to_owned(),
                start,
                end,
                suggestion: None,
                quick_action: None,
            });
        }
    }

    hits.sort_by_key(|h| (h.start, h.end));
    hits
}

/// Flag personal crutch words configured in user settings (supports plain words or `"word => replacement"`).
pub fn scan_crutch_words(text: &str, crutch_words: &[String]) -> Vec<WritingGuardHit> {
    if text.trim().is_empty() || crutch_words.is_empty() {
        return Vec::new();
    }

    let mut entries: Vec<(&str, Option<&str>)> = Vec::new();
    for raw in crutch_words {
        let (term, repl) = parse_custom_slop_entry(raw);
        if !term.is_empty()
            && !entries
                .iter()
                .any(|(existing, _)| existing.eq_ignore_ascii_case(term))
        {
            entries.push((term, repl));
        }
    }
    if entries.is_empty() {
        return Vec::new();
    }

    let patterns: Vec<&str> = entries.iter().map(|(t, _)| *t).collect();
    let Ok(matcher) = AhoCorasickBuilder::new()
        .ascii_case_insensitive(true)
        .match_kind(MatchKind::LeftmostLongest)
        .build(patterns)
    else {
        return Vec::new();
    };

    let ignored = ignored_prose_ranges(text);
    let bytes = text.as_bytes();
    let mut hits = Vec::new();

    for m in matcher.find_iter(text) {
        let start = m.start();
        let end = m.end();
        if overlaps_ignored_ranges(start, end, &ignored) {
            continue;
        }
        let prev_ok = start == 0 || !is_word_byte(bytes[start - 1]);
        let next_ok = end == bytes.len() || !is_word_byte(bytes[end]);
        if !prev_ok || !next_ok {
            continue;
        }
        let matched = &text[start..end];
        let custom_repl = entries[m.pattern().as_usize()].1;
        let suggestion = match custom_repl {
            Some(r) if !r.is_empty() => Some(preserve_case(matched, r)),
            _ => Some(String::new()),
        };
        let message = match custom_repl {
            Some(r) if !r.is_empty() => {
                format!("Personal crutch word \"{matched}\". Replace with \"{r}\".")
            }
            _ => format!("Personal crutch word \"{matched}\". Cut it for tighter phrasing."),
        };
        hits.push(WritingGuardHit {
            kind: WritingGuardKind::CrutchWord,
            severity: WritingGuardSeverity::Info,
            rule_id: "crutch_word".to_owned(),
            message,
            matched_text: matched.to_owned(),
            start,
            end,
            suggestion,
            quick_action: Some("remove_crutch".to_owned()),
        });
    }

    hits.sort_by_key(|h| (h.start, h.end));
    hits
}

fn split_prose_blocks(text: &str, ignored: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let mut blocks = Vec::new();
    let mut block_start: Option<usize> = None;
    let mut block_end = 0usize;
    let mut offset = 0usize;

    for line in text.split_inclusive('\n') {
        let line_end = offset + line.len();
        let trimmed = line.trim();
        let in_ignored = overlaps_ignored_ranges(offset, line_end, ignored);
        if trimmed.is_empty() || in_ignored {
            if let Some(start) = block_start.take() {
                blocks.push((start, block_end));
            }
        } else {
            if block_start.is_none() {
                block_start = Some(offset);
            }
            block_end = line_end;
        }
        offset = line_end;
    }
    if let Some(start) = block_start {
        blocks.push((start, block_end));
    }
    blocks
}

fn find_ask_sentences(text: &str, ignored: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let matcher = ask_signal_matcher();
    let mut asks = Vec::new();
    let mut seg_start = 0usize;

    for (idx, ch) in text.char_indices() {
        if matches!(ch, '.' | '!' | '?' | '\n') {
            let seg_end = idx + ch.len_utf8();
            maybe_record_ask(text, seg_start, seg_end, ignored, matcher, &mut asks);
            seg_start = seg_end;
        }
    }
    if seg_start < text.len() {
        maybe_record_ask(text, seg_start, text.len(), ignored, matcher, &mut asks);
    }
    asks
}

fn maybe_record_ask(
    text: &str,
    raw_start: usize,
    raw_end: usize,
    ignored: &[(usize, usize)],
    matcher: &AhoCorasick,
    out: &mut Vec<(usize, usize)>,
) {
    let slice = &text[raw_start..raw_end];
    let trimmed_start = slice.trim_start();
    let start = raw_start + slice.len().saturating_sub(trimmed_start.len());
    let trimmed = trimmed_start.trim_end();
    let end = start + trimmed.len();
    if start >= end || overlaps_ignored_ranges(start, end, ignored) {
        return;
    }
    if trimmed.ends_with('?') || matcher.is_match(trimmed) {
        out.push((start, end));
    }
}

fn is_list_line(trimmed: &str) -> bool {
    if trimmed.starts_with("- ") || trimmed.starts_with("* ") || trimmed.starts_with("+ ") {
        return true;
    }
    let digits = trimmed.chars().take_while(|c| c.is_ascii_digit()).count();
    digits > 0
        && trimmed[digits..].starts_with(['.', ')'])
        && trimmed[digits + 1..].starts_with(' ')
}

fn surface_display_name(surface_id: &str) -> &'static str {
    match surface_id {
        "web_email" | "email" => "Email",
        "web_discord_slack" | "slack" => "Chat",
        "web_github_pr" | "github_pr" => "GitHub PR",
        _ => "this surface",
    }
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for (idx, ch) in text.trim().chars().enumerate() {
        if idx >= max_chars {
            out.push_str("...");
            break;
        }
        out.push(ch);
    }
    out
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}
