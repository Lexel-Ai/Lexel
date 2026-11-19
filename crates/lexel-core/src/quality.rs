use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::profile::StyleGuideRule;
use crate::slop::{ignored_prose_ranges, overlaps_ignored_ranges};
use crate::verifier::SafeFixResult;

/// A detected hidden Unicode watermark, zero-width control, or bidi character.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InvisibleCharHit {
    pub codepoint: String,
    pub label: String,
    pub start: usize,
    pub end: usize,
    pub replacement: String,
}

/// Deterministic structure or punctuation issue (unbalanced delimiters, duplicate words, mixed quotes).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StructureIssue {
    pub kind: String,
    pub message: String,
    pub problem_text: String,
    pub start: usize,
    pub end: usize,
    pub suggestion: Option<String>,
}

/// A brand or team style guide violation with its preferred replacement.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StyleGuideHit {
    pub term: String,
    pub preferred: String,
    pub note: Option<String>,
    pub start: usize,
    pub end: usize,
}

/// Target Flesch-Kincaid grade range for a writing surface.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceGradeTarget {
    pub min_grade: f64,
    pub max_grade: f64,
    pub audience_label: &'static str,
}

/// Return the recommended Flesch-Kincaid grade window for a surface ID.
pub fn surface_grade_target(surface_id: &str) -> SurfaceGradeTarget {
    match surface_id {
        "web_x" => SurfaceGradeTarget {
            min_grade: 5.0,
            max_grade: 9.0,
            audience_label: "Punchy social",
        },
        "web_discord_slack" => SurfaceGradeTarget {
            min_grade: 5.0,
            max_grade: 10.0,
            audience_label: "Fast team chat",
        },
        "web_email" => SurfaceGradeTarget {
            min_grade: 6.0,
            max_grade: 11.0,
            audience_label: "Clear business email",
        },
        "web_linkedin" | "web_reddit" | "web_discourse" => SurfaceGradeTarget {
            min_grade: 6.0,
            max_grade: 12.0,
            audience_label: "Conversational prose",
        },
        "web_github_pr" | "ide_git_commit" | "ide_code_comment" | "docs_markdown" => {
            SurfaceGradeTarget {
                min_grade: 7.0,
                max_grade: 14.0,
                audience_label: "Technical engineering",
            }
        }
        _ => SurfaceGradeTarget {
            min_grade: 6.0,
            max_grade: 12.0,
            audience_label: "Clear general prose",
        },
    }
}

fn classify_invisible_char(ch: char) -> Option<(&'static str, &'static str)> {
    match ch {
        '\u{200B}' => Some(("Zero-width space", "")),
        '\u{200C}' => Some(("Zero-width non-joiner", "")),
        '\u{200D}' => Some(("Zero-width joiner", "")),
        '\u{2060}' => Some(("Word joiner", "")),
        '\u{FEFF}' => Some(("Byte-order mark / ZWNBSP", "")),
        '\u{00AD}' => Some(("Soft hyphen", "")),
        '\u{202F}' => Some(("Narrow no-break space", " ")),
        '\u{200E}' | '\u{200F}' => Some(("Directional mark", "")),
        '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' => Some(("Bidi control override", "")),
        _ => None,
    }
}

/// Scan text for hidden Unicode watermarks, zero-width characters, soft hyphens, and bidi controls.
pub fn scan_invisible_chars(text: &str) -> Vec<InvisibleCharHit> {
    let mut hits = Vec::new();
    for (idx, ch) in text.char_indices() {
        if let Some((label, replacement)) = classify_invisible_char(ch) {
            hits.push(InvisibleCharHit {
                codepoint: format!("U+{:04X}", ch as u32),
                label: label.to_owned(),
                start: idx,
                end: idx + ch.len_utf8(),
                replacement: replacement.to_owned(),
            });
        }
    }
    hits
}

/// Remove hidden Unicode watermarks and normalize narrow no-break spaces deterministically.
pub fn strip_invisible_chars(text: &str) -> SafeFixResult {
    let mut out = String::with_capacity(text.len());
    let mut fixes = 0usize;
    for ch in text.chars() {
        if let Some((_label, replacement)) = classify_invisible_char(ch) {
            out.push_str(replacement);
            fixes += 1;
        } else {
            out.push(ch);
        }
    }
    SafeFixResult {
        text: if fixes > 0 { out } else { text.to_owned() },
        fixes_applied: fixes,
        categories: if fixes > 0 {
            vec!["invisible_chars".to_owned()]
        } else {
            Vec::new()
        },
    }
}

/// Scan prose for unclosed parentheses/brackets/quotes/backticks, duplicate adjacent words, and mixed quotes.
pub fn scan_structure_issues(text: &str) -> Vec<StructureIssue> {
    let mut issues = Vec::new();
    let ignored = ignored_prose_ranges(text);

    // 1. Adjacent duplicate words (case-insensitive, e.g., "the the") outside code/quotes.
    let mut prev_word: Option<(&str, usize, usize)> = None;
    let mut word_start: Option<usize> = None;
    let mut last_word_end = 0usize;

    for (idx, ch) in text.char_indices() {
        if ch.is_ascii_alphabetic() {
            if word_start.is_none() {
                word_start = Some(idx);
            }
            last_word_end = idx + ch.len_utf8();
        } else {
            if let Some(ws) = word_start.take() {
                let word = &text[ws..last_word_end];
                if !overlaps_ignored_ranges(ws, last_word_end, &ignored) {
                    if let Some((prev, p_start, p_end)) = prev_word {
                        let gap = &text[p_end..ws];
                        if !gap.is_empty()
                            && gap.chars().all(|g| g == ' ' || g == '\t')
                            && prev.eq_ignore_ascii_case(word)
                            && word.len() >= 2
                        {
                            issues.push(StructureIssue {
                                kind: "duplicate_word".to_owned(),
                                message: format!(
                                    "Duplicate word \"{word}\". Remove repeated word."
                                ),
                                problem_text: text[p_start..last_word_end].to_owned(),
                                start: p_start,
                                end: last_word_end,
                                suggestion: Some(prev.to_owned()),
                            });
                        }
                    }
                    prev_word = Some((word, ws, last_word_end));
                } else {
                    prev_word = None;
                }
            }
            if ch != ' ' && ch != '\t' {
                prev_word = None;
            }
        }
    }
    if let Some(ws) = word_start {
        let word = &text[ws..last_word_end];
        if !overlaps_ignored_ranges(ws, last_word_end, &ignored)
            && let Some((prev, p_start, p_end)) = prev_word
        {
            let gap = &text[p_end..ws];
            if !gap.is_empty()
                && gap.chars().all(|g| g == ' ' || g == '\t')
                && prev.eq_ignore_ascii_case(word)
                && word.len() >= 2
            {
                issues.push(StructureIssue {
                    kind: "duplicate_word".to_owned(),
                    message: format!("Duplicate word \"{word}\". Remove repeated word."),
                    problem_text: text[p_start..last_word_end].to_owned(),
                    start: p_start,
                    end: last_word_end,
                    suggestion: Some(prev.to_owned()),
                });
            }
        }
    }

    // 2. Unbalanced (), [], straight double quotes, and inline backticks outside fenced code blocks.
    let mut fenced_ranges = Vec::new();
    let mut search_from = 0usize;
    while let Some(rel) = text[search_from..].find("```") {
        let open = search_from + rel;
        let after_open = open + 3;
        if let Some(close_rel) = text[after_open..].find("```") {
            let close = after_open + close_rel + 3;
            fenced_ranges.push((open, close));
            search_from = close;
        } else {
            fenced_ranges.push((open, text.len()));
            break;
        }
    }

    let mut paren_stack: Vec<usize> = Vec::new();
    let mut bracket_stack: Vec<usize> = Vec::new();
    let mut straight_dquotes: Vec<usize> = Vec::new();
    let mut backticks: Vec<usize> = Vec::new();
    let mut has_curly_quotes = false;
    let mut first_curly_idx: Option<(usize, usize)> = None;
    let mut has_straight_quotes = false;

    for (idx, ch) in text.char_indices() {
        let end = idx + ch.len_utf8();
        if overlaps_ignored_ranges(idx, end, &fenced_ranges) {
            continue;
        }
        match ch {
            '(' => paren_stack.push(idx),
            ')' => {
                if paren_stack.pop().is_none() {
                    issues.push(StructureIssue {
                        kind: "unbalanced_delimiter".to_owned(),
                        message: "Unexpected closing parenthesis ')'.".to_owned(),
                        problem_text: ")".to_owned(),
                        start: idx,
                        end,
                        suggestion: None,
                    });
                }
            }
            '[' => bracket_stack.push(idx),
            ']' => {
                if bracket_stack.pop().is_none() {
                    issues.push(StructureIssue {
                        kind: "unbalanced_delimiter".to_owned(),
                        message: "Unexpected closing bracket ']'.".to_owned(),
                        problem_text: "]".to_owned(),
                        start: idx,
                        end,
                        suggestion: None,
                    });
                }
            }
            '"' => {
                has_straight_quotes = true;
                straight_dquotes.push(idx);
            }
            '“' | '”' => {
                has_curly_quotes = true;
                if first_curly_idx.is_none() {
                    first_curly_idx = Some((idx, end));
                }
            }
            '`' => backticks.push(idx),
            _ => {}
        }
    }

    if let Some(open_idx) = paren_stack.pop() {
        issues.push(StructureIssue {
            kind: "unbalanced_delimiter".to_owned(),
            message: "Unclosed parenthesis '('.".to_owned(),
            problem_text: "(".to_owned(),
            start: open_idx,
            end: open_idx + 1,
            suggestion: None,
        });
    }
    if let Some(open_idx) = bracket_stack.pop() {
        issues.push(StructureIssue {
            kind: "unbalanced_delimiter".to_owned(),
            message: "Unclosed bracket '['.".to_owned(),
            problem_text: "[".to_owned(),
            start: open_idx,
            end: open_idx + 1,
            suggestion: None,
        });
    }
    if straight_dquotes.len() % 2 == 1
        && let Some(&open_idx) = straight_dquotes.last()
    {
        issues.push(StructureIssue {
            kind: "unbalanced_quote".to_owned(),
            message: "Unclosed double quote '\"'.".to_owned(),
            problem_text: "\"".to_owned(),
            start: open_idx,
            end: open_idx + 1,
            suggestion: None,
        });
    }
    if backticks.len() % 2 == 1
        && let Some(&open_idx) = backticks.last()
    {
        issues.push(StructureIssue {
            kind: "unbalanced_backtick".to_owned(),
            message: "Unclosed inline code backtick '`'.".to_owned(),
            problem_text: "`".to_owned(),
            start: open_idx,
            end: open_idx + 1,
            suggestion: None,
        });
    }
    if has_curly_quotes
        && has_straight_quotes
        && let Some((c_start, c_end)) = first_curly_idx
    {
        issues.push(StructureIssue {
            kind: "mixed_quotes".to_owned(),
            message: "Mixed curly and straight double quotes. Normalize quote style.".to_owned(),
            problem_text: text[c_start..c_end].to_owned(),
            start: c_start,
            end: c_end,
            suggestion: Some("\"".to_owned()),
        });
    }

    issues.sort_by_key(|i| (i.start, i.end));
    issues
}

/// Scan prose for violations of user/team style guide terminology rules outside code blocks.
pub fn scan_style_guide(text: &str, rules: &[StyleGuideRule]) -> Vec<StyleGuideHit> {
    if text.trim().is_empty() || rules.is_empty() {
        return Vec::new();
    }
    let ignored = ignored_prose_ranges(text);
    let mut hits = Vec::new();

    for rule in rules {
        let term = rule.term.trim();
        let preferred = rule.preferred.trim();
        if term.is_empty() || preferred.is_empty() {
            continue;
        }
        let start_b = if term
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        {
            r"\b"
        } else {
            ""
        };
        let end_b = if term
            .chars()
            .last()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        {
            r"\b"
        } else {
            ""
        };
        let flags = if rule.case_sensitive { "" } else { "(?i)" };
        let pattern = format!("{flags}{start_b}{}{end_b}", regex::escape(term));
        let Ok(re) = Regex::new(&pattern) else {
            continue;
        };
        for m in re.find_iter(text) {
            if overlaps_ignored_ranges(m.start(), m.end(), &ignored) {
                continue;
            }
            if m.as_str() == preferred {
                continue;
            }
            hits.push(StyleGuideHit {
                term: m.as_str().to_owned(),
                preferred: preferred.to_owned(),
                note: rule.note.clone().filter(|n| !n.trim().is_empty()),
                start: m.start(),
                end: m.end(),
            });
        }
    }

    hits.sort_by_key(|h| (h.start, h.end));
    hits
}

/// Deterministically apply all team style guide replacements outside code/quote ranges.
pub fn apply_style_guide_fixes(text: &str, rules: &[StyleGuideRule]) -> SafeFixResult {
    if text.trim().is_empty() || rules.is_empty() {
        return SafeFixResult {
            text: text.to_owned(),
            fixes_applied: 0,
            categories: Vec::new(),
        };
    }

    let mut current = text.to_owned();
    let mut fixes = 0usize;
    let mut sorted_rules: Vec<&StyleGuideRule> = rules.iter().collect();
    sorted_rules.sort_by_key(|a| std::cmp::Reverse(a.term.len()));

    for rule in sorted_rules {
        let term = rule.term.trim();
        let preferred = rule.preferred.trim();
        if term.is_empty() || preferred.is_empty() {
            continue;
        }
        let start_b = if term
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        {
            r"\b"
        } else {
            ""
        };
        let end_b = if term
            .chars()
            .last()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        {
            r"\b"
        } else {
            ""
        };
        let flags = if rule.case_sensitive { "" } else { "(?i)" };
        let pattern = format!("{flags}{start_b}{}{end_b}", regex::escape(term));
        let Ok(re) = Regex::new(&pattern) else {
            continue;
        };
        let ignored = ignored_prose_ranges(&current);
        let mut matched_here = 0usize;
        let replaced = re.replace_all(&current, |caps: &regex::Captures<'_>| {
            let m = caps.get(0).expect("full match");
            if overlaps_ignored_ranges(m.start(), m.end(), &ignored) || m.as_str() == preferred {
                m.as_str().to_owned()
            } else {
                matched_here += 1;
                preferred.to_owned()
            }
        });
        if matched_here > 0 {
            current = replaced.into_owned();
            fixes += matched_here;
        }
    }

    SafeFixResult {
        text: current,
        fixes_applied: fixes,
        categories: if fixes > 0 {
            vec!["style_guide".to_owned()]
        } else {
            Vec::new()
        },
    }
}
