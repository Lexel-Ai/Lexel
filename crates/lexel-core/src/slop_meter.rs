use std::sync::OnceLock;

use aho_corasick::{AhoCorasick, AhoCorasickBuilder, MatchKind};
use serde::{Deserialize, Serialize};

use crate::slop::{SlopScanner, ignored_prose_ranges, overlaps_ignored_ranges};

/// Category of signal contributing to the Human vs. AI-slop score.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SlopMeterContributorKind {
    Cliche,
    EmDash,
    FillerOpener,
    FlatRhythm,
}

/// A span in the input text that raised the AI-slop score.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SlopMeterSpan {
    pub kind: SlopMeterContributorKind,
    pub label: String,
    pub matched_text: String,
    pub start: usize,
    pub end: usize,
    pub weight: f64,
}

/// Component breakdown of the Live Human vs. AI-slop meter.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SlopMeterBreakdown {
    pub cliche_points: u8,
    pub em_dash_points: u8,
    pub filler_opener_points: u8,
    pub flat_rhythm_points: u8,
    pub cliche_density_per_100_words: f64,
    pub em_dash_count: usize,
    pub filler_opener_count: usize,
    pub sentence_length_stddev: f64,
}

/// Coarse bucket label for the AI-slop score.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SlopMeterLabel {
    Human,
    MildAi,
    LikelyAi,
    HeavySlop,
}

/// Options controlling the Live Human vs. AI-slop meter and pasted-AI check.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SlopMeterOptions {
    #[serde(default)]
    pub allow_em_dashes: bool,
    #[serde(default)]
    pub custom_slop_terms: Vec<String>,
    #[serde(default)]
    pub disabled_slop_terms: Vec<String>,
    #[serde(default)]
    pub surface_banned_openers: Vec<String>,
}

/// Deterministic score and span breakdown for the Live Human vs. AI-slop meter.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SlopMeterReport {
    pub score: u8,
    pub human_score: u8,
    pub label: SlopMeterLabel,
    pub word_count: usize,
    pub cliche_count: usize,
    pub em_dash_count: usize,
    pub filler_opener_count: usize,
    pub rhythm_flatness: f64,
    pub breakdown: SlopMeterBreakdown,
    pub contributors: Vec<SlopMeterSpan>,
}

/// Thresholds controlling when pasted text triggers the "Humanize pasted text" pill.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PastedAiThresholds {
    pub min_chars: usize,
    pub min_score: u8,
    pub min_signals: usize,
    pub min_density_per_100_words: f64,
}

impl Default for PastedAiThresholds {
    fn default() -> Self {
        Self {
            min_chars: 120,
            min_score: 35,
            min_signals: 2,
            min_density_per_100_words: 2.5,
        }
    }
}

/// Decision returned by `detect_pasted_ai` for showing the "Humanize pasted text" pill.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PastedAiAssessment {
    pub should_offer_humanize: bool,
    pub char_count: usize,
    pub word_count: usize,
    pub slop_score: u8,
    pub slop_density_per_100_words: f64,
    pub signal_count: usize,
    pub reason: Option<String>,
    pub meter: SlopMeterReport,
}

const DEFAULT_FILLER_OPENERS: &[&str] = &[
    "in today's",
    "in an era",
    "in the ever-evolving",
    "in the rapidly evolving",
    "it is important to note",
    "it's important to note",
    "it is worth noting",
    "it's worth noting",
    "needless to say",
    "without further ado",
    "i hope this email finds you well",
    "i hope this message finds you well",
    "at the end of the day",
    "in conclusion",
    "to summarize",
    "when it comes to",
    "delving into",
    "certainly!",
    "absolutely!",
    "great question",
];

fn filler_opener_matcher() -> &'static AhoCorasick {
    static MATCHER: OnceLock<AhoCorasick> = OnceLock::new();
    MATCHER.get_or_init(|| {
        AhoCorasickBuilder::new()
            .ascii_case_insensitive(true)
            .match_kind(MatchKind::LeftmostLongest)
            .build(DEFAULT_FILLER_OPENERS)
            .expect("static filler openers must compile")
    })
}

/// Score text for AI-slop density, em-dash overuse, filler openers, and flat sentence rhythm.
pub fn score_slop_meter(text: &str, options: &SlopMeterOptions) -> SlopMeterReport {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return SlopMeterReport {
            score: 0,
            human_score: 100,
            label: SlopMeterLabel::Human,
            word_count: 0,
            cliche_count: 0,
            em_dash_count: 0,
            filler_opener_count: 0,
            rhythm_flatness: 0.0,
            breakdown: SlopMeterBreakdown {
                cliche_points: 0,
                em_dash_points: 0,
                filler_opener_points: 0,
                flat_rhythm_points: 0,
                cliche_density_per_100_words: 0.0,
                em_dash_count: 0,
                filler_opener_count: 0,
                sentence_length_stddev: 0.0,
            },
            contributors: Vec::new(),
        };
    }

    let ignored = ignored_prose_ranges(text);
    let prose_word_count = count_prose_words(text, &ignored);
    let scanner = SlopScanner::shared();
    // Always scan em dashes so the meter tracks overuse even on surfaces that permit them.
    let slop_hits = scanner.scan_with_overrides(
        text,
        false,
        &options.custom_slop_terms,
        &options.disabled_slop_terms,
    );

    let mut contributors: Vec<SlopMeterSpan> = Vec::with_capacity(slop_hits.len() + 4);
    let mut cliche_count = 0usize;
    let mut em_dash_count = 0usize;

    for hit in &slop_hits {
        if hit.is_em_dash {
            em_dash_count += 1;
            let weight = if options.allow_em_dashes { 5.0 } else { 10.0 };
            contributors.push(SlopMeterSpan {
                kind: SlopMeterContributorKind::EmDash,
                label: "Em dash phrasing".to_owned(),
                matched_text: hit.term.clone(),
                start: hit.start,
                end: hit.end,
                weight,
            });
        } else {
            cliche_count += 1;
            contributors.push(SlopMeterSpan {
                kind: SlopMeterContributorKind::Cliche,
                label: format!("AI cliché \"{}\"", hit.term),
                matched_text: hit.term.clone(),
                start: hit.start,
                end: hit.end,
                weight: 12.0,
            });
        }
    }

    let opener_hits = scan_filler_openers(text, &ignored, &options.surface_banned_openers);
    let filler_opener_count = opener_hits.len();
    contributors.extend(opener_hits);

    let effective_words = prose_word_count.max(10) as f64;
    let cliche_density_per_100_words = round_1((cliche_count as f64 / effective_words) * 100.0);

    let cliche_points = if cliche_count == 0 {
        0
    } else {
        ((cliche_count as f64 * 12.0) + (cliche_density_per_100_words * 2.5))
            .min(45.0)
            .round() as u8
    };

    let em_dash_points = if em_dash_count == 0 {
        0
    } else if options.allow_em_dashes {
        if em_dash_count <= 1 {
            0
        } else {
            (((em_dash_count - 1) as f64) * 6.0).min(20.0).round() as u8
        }
    } else {
        ((em_dash_count as f64) * 10.0).min(25.0).round() as u8
    };

    let filler_opener_points = ((filler_opener_count as f64) * 10.0).min(20.0).round() as u8;

    let (rhythm_flatness, sentence_length_stddev, flat_span) =
        analyze_sentence_rhythm(text, &ignored);
    let flat_rhythm_points = if rhythm_flatness >= 0.45 {
        (rhythm_flatness * 15.0).round() as u8
    } else {
        0
    };
    if flat_rhythm_points > 0
        && let Some((start, end)) = flat_span
    {
        let preview = truncate_preview(&text[start..end], 64);
        contributors.push(SlopMeterSpan {
            kind: SlopMeterContributorKind::FlatRhythm,
            label: "Uniform sentence cadence".to_owned(),
            matched_text: preview,
            start,
            end,
            weight: f64::from(flat_rhythm_points),
        });
    }

    contributors.sort_by_key(|c| (c.start, c.end));

    let score = cliche_points
        .saturating_add(em_dash_points)
        .saturating_add(filler_opener_points)
        .saturating_add(flat_rhythm_points)
        .min(100);
    let human_score = 100u8.saturating_sub(score);
    let label = match score {
        0..=20 => SlopMeterLabel::Human,
        21..=45 => SlopMeterLabel::MildAi,
        46..=70 => SlopMeterLabel::LikelyAi,
        _ => SlopMeterLabel::HeavySlop,
    };

    SlopMeterReport {
        score,
        human_score,
        label,
        word_count: prose_word_count,
        cliche_count,
        em_dash_count,
        filler_opener_count,
        rhythm_flatness: round_2(rhythm_flatness),
        breakdown: SlopMeterBreakdown {
            cliche_points,
            em_dash_points,
            filler_opener_points,
            flat_rhythm_points,
            cliche_density_per_100_words,
            em_dash_count,
            filler_opener_count,
            sentence_length_stddev: round_2(sentence_length_stddev),
        },
        contributors,
    }
}

/// Decide whether pasted text should surface the "Humanize pasted text" pill using default thresholds.
pub fn detect_pasted_ai(text: &str, options: &SlopMeterOptions) -> PastedAiAssessment {
    detect_pasted_ai_with_thresholds(text, options, &PastedAiThresholds::default())
}

/// Decide whether pasted text should surface the "Humanize pasted text" pill with custom thresholds.
pub fn detect_pasted_ai_with_thresholds(
    text: &str,
    options: &SlopMeterOptions,
    thresholds: &PastedAiThresholds,
) -> PastedAiAssessment {
    let meter = score_slop_meter(text, options);
    let char_count = text.trim().chars().count();
    let signal_count = meter.cliche_count + meter.em_dash_count + meter.filler_opener_count;
    let density = if meter.word_count > 0 {
        round_1((signal_count as f64 / meter.word_count as f64) * 100.0)
    } else {
        0.0
    };

    let meets_length = char_count >= thresholds.min_chars;
    let has_explicit_signal = signal_count > 0;
    let meets_density =
        signal_count >= thresholds.min_signals && density >= thresholds.min_density_per_100_words;
    let meets_score = meter.score >= thresholds.min_score && has_explicit_signal;

    let should_offer_humanize = meets_length && (meets_score || meets_density);
    let reason = if should_offer_humanize {
        let noun = if signal_count == 1 {
            "AI pattern"
        } else {
            "AI patterns"
        };
        Some(format!(
            "{signal_count} {noun} detected (slop score {}/100)",
            meter.score
        ))
    } else {
        None
    };

    PastedAiAssessment {
        should_offer_humanize,
        char_count,
        word_count: meter.word_count,
        slop_score: meter.score,
        slop_density_per_100_words: density,
        signal_count,
        reason,
        meter,
    }
}

fn scan_filler_openers(
    text: &str,
    ignored: &[(usize, usize)],
    surface_openers: &[String],
) -> Vec<SlopMeterSpan> {
    let mut hits = Vec::new();
    let bytes = text.as_bytes();
    let matcher = filler_opener_matcher();

    for m in matcher.find_iter(text) {
        let start = m.start();
        let end = m.end();
        if overlaps_ignored_ranges(start, end, ignored) {
            continue;
        }
        if !is_opener_position(text, start) {
            continue;
        }
        let next_ok = end == bytes.len() || !is_word_byte(bytes[end]);
        if !next_ok {
            continue;
        }
        hits.push(SlopMeterSpan {
            kind: SlopMeterContributorKind::FillerOpener,
            label: format!("Filler opener \"{}\"", &text[start..end]),
            matched_text: text[start..end].to_owned(),
            start,
            end,
            weight: 10.0,
        });
    }

    if !surface_openers.is_empty() {
        let trimmed = text.trim_start();
        let lead = text.len().saturating_sub(trimmed.len());
        let lower = trimmed.to_ascii_lowercase();
        for opener in surface_openers {
            let op_lower = opener.trim().to_ascii_lowercase();
            if op_lower.is_empty() || !lower.starts_with(&op_lower) {
                continue;
            }
            let start = lead;
            let end = lead + op_lower.len();
            if overlaps_ignored_ranges(start, end, ignored)
                || hits.iter().any(|h| start < h.end && end > h.start)
            {
                continue;
            }
            if end < bytes.len() && is_word_byte(bytes[end]) {
                continue;
            }
            hits.push(SlopMeterSpan {
                kind: SlopMeterContributorKind::FillerOpener,
                label: format!("Surface filler opener \"{}\"", &text[start..end]),
                matched_text: text[start..end].to_owned(),
                start,
                end,
                weight: 10.0,
            });
        }
    }

    hits
}

/// True when `start` sits at the beginning of the document, a paragraph, or a sentence.
fn is_opener_position(text: &str, start: usize) -> bool {
    let before = text[..start].trim_end();
    if before.is_empty() {
        return true;
    }
    let last_char = before.chars().next_back();
    matches!(last_char, Some('.' | '!' | '?' | '\n' | ':'))
        || text[before.len()..start].contains('\n')
}

fn count_prose_words(text: &str, ignored: &[(usize, usize)]) -> usize {
    let mut words = 0usize;
    let mut in_word = false;
    let mut word_start = 0usize;
    for (idx, ch) in text.char_indices() {
        if ch.is_alphanumeric() || ch == '\'' || ch == '-' {
            if !in_word {
                in_word = true;
                word_start = idx;
            }
        } else if in_word {
            if !overlaps_ignored_ranges(word_start, idx, ignored) {
                words += 1;
            }
            in_word = false;
        }
    }
    if in_word && !overlaps_ignored_ranges(word_start, text.len(), ignored) {
        words += 1;
    }
    words
}

/// Measure sentence-length uniformity across prose sentences (>=3 words each).
/// Returns `(flatness_0_to_1, stddev_words, optional_span)`.
fn analyze_sentence_rhythm(
    text: &str,
    ignored: &[(usize, usize)],
) -> (f64, f64, Option<(usize, usize)>) {
    let mut sentences: Vec<(usize, usize, usize)> = Vec::new();
    let mut seg_start = 0usize;

    for (idx, ch) in text.char_indices() {
        if matches!(ch, '.' | '!' | '?' | '\n') {
            let seg_end = idx + ch.len_utf8();
            push_sentence_if_prose(text, seg_start, seg_end, ignored, &mut sentences);
            seg_start = seg_end;
        }
    }
    if seg_start < text.len() {
        push_sentence_if_prose(text, seg_start, text.len(), ignored, &mut sentences);
    }

    // Need at least 3 substantive sentences before calling rhythm flat.
    if sentences.len() < 3 {
        return (0.0, 0.0, None);
    }

    let n = sentences.len() as f64;
    let mean = sentences.iter().map(|s| s.2 as f64).sum::<f64>() / n;
    if mean < 6.0 {
        return (0.0, 0.0, None);
    }

    let variance = sentences
        .iter()
        .map(|s| {
            let diff = s.2 as f64 - mean;
            diff * diff
        })
        .sum::<f64>()
        / n;
    let stddev = variance.sqrt();
    let cv = stddev / mean;

    let flatness = if cv >= 0.32 {
        0.0
    } else {
        ((0.32 - cv) / 0.32).clamp(0.0, 1.0)
    };
    let span = Some((
        sentences.first().map(|s| s.0).unwrap_or(0),
        sentences.last().map(|s| s.1).unwrap_or(text.len()),
    ));

    (flatness, stddev, span)
}

fn push_sentence_if_prose(
    text: &str,
    raw_start: usize,
    raw_end: usize,
    ignored: &[(usize, usize)],
    out: &mut Vec<(usize, usize, usize)>,
) {
    let slice = &text[raw_start..raw_end];
    let trimmed_start = slice.trim_start();
    let start = raw_start + slice.len().saturating_sub(trimmed_start.len());
    let trimmed = trimmed_start.trim_end();
    let end = start + trimmed.len();
    if start >= end || overlaps_ignored_ranges(start, end, ignored) {
        return;
    }
    let words = trimmed
        .split_whitespace()
        .filter(|w| w.chars().any(|c| c.is_alphanumeric()))
        .count();
    if words >= 4 {
        out.push((start, end, words));
    }
}

fn truncate_preview(slice: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for (idx, ch) in slice.chars().enumerate() {
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

fn round_1(val: f64) -> f64 {
    (val * 10.0).round() / 10.0
}

fn round_2(val: f64) -> f64 {
    (val * 100.0).round() / 100.0
}
