use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::slop::{
    ignored_prose_ranges, overlaps_ignored_ranges, parse_custom_slop_entry, preserve_case,
};
use crate::{CoreError, HarperEngine, SlopScanner, SurfaceCatalog, SurfaceProfile, scan_secrets};

/// Verification summary matching `GateCheckSummary` in `packages/lexel-ui`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GateCheckSummary {
    pub zero_slop: bool,
    pub numbers_preserved: bool,
    pub tokens_preserved: bool,
    pub surface_compliant: bool,
    pub grammar_clean: bool,
    pub secrets_free: bool,
    pub warnings: Vec<String>,
}

/// Deterministic zero-AI cleanup result from `apply_safe_deterministic_fixes`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SafeFixResult {
    pub text: String,
    pub fixes_applied: usize,
    pub categories: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
struct UnitMetric {
    raw: String,
    value: f64,
    unit: String,
}

/// Strip wrapper artifacts (`<think>...</think>`, markdown code fences, outer quotes) from model output.
pub fn sanitize_model_output(raw: &str) -> String {
    let mut cleaned = raw.trim().to_owned();
    if let Ok(think_re) = Regex::new(r"(?is)<think>.*?</think>") {
        cleaned = think_re.replace_all(&cleaned, "").trim().to_owned();
    }
    if cleaned.starts_with("```")
        && cleaned.ends_with("```")
        && let Ok(fence_re) = Regex::new(r"(?is)^```[a-z]*\n?|\n?```$")
    {
        cleaned = fence_re.replace_all(&cleaned, "").trim().to_owned();
    }
    if (cleaned.starts_with('"') && cleaned.ends_with('"') && cleaned.len() >= 2)
        || (cleaned.starts_with('\'') && cleaned.ends_with('\'') && cleaned.len() >= 2)
    {
        cleaned = cleaned[1..cleaned.len() - 1].trim().to_owned();
    }
    cleaned
}

/// Tier 2 deterministic gatekeeper validating AI rewrite candidates before they reach the user.
pub fn verify_rewrite(
    source: &str,
    candidate: &str,
    surface_id: &str,
    dialect_code: u8,
    user_words: &[String],
) -> Result<GateCheckSummary, CoreError> {
    verify_rewrite_with_surfaces(source, candidate, surface_id, dialect_code, user_words, &[])
}

/// Tier 2 deterministic gatekeeper validating AI rewrite candidates with user-configured surface overrides.
pub fn verify_rewrite_with_surfaces(
    source: &str,
    candidate: &str,
    surface_id: &str,
    dialect_code: u8,
    user_words: &[String],
    custom_surfaces: &[SurfaceProfile],
) -> Result<GateCheckSummary, CoreError> {
    let slop_scanner = SlopScanner::load_embedded()?;
    let catalog = SurfaceCatalog::load_with_custom(custom_surfaces)?;
    let profile = catalog.get(surface_id)?;
    let mut warnings = Vec::new();

    let slop_hits = slop_scanner.scan(candidate, profile.allow_em_dashes);
    let zero_slop = slop_hits.is_empty();
    for hit in &slop_hits {
        if hit.is_em_dash {
            warnings.push("Contains an em dash.".to_owned());
        } else {
            warnings.push(format!("Contains AI phrasing: \"{}\"", hit.term));
        }
    }

    let source_metrics = extract_unit_bound_metrics(source)?;
    let candidate_metrics = extract_unit_bound_metrics(candidate)?;

    let missing_metrics: Vec<&UnitMetric> = source_metrics
        .iter()
        .filter(|sm| {
            !candidate_metrics
                .iter()
                .any(|cm| (cm.value - sm.value).abs() < 1e-9 && cm.unit == sm.unit)
        })
        .collect();

    let invented_metrics: Vec<&UnitMetric> = candidate_metrics
        .iter()
        .filter(|cm| {
            !source_metrics
                .iter()
                .any(|sm| (sm.value - cm.value).abs() < 1e-9 && sm.unit == cm.unit)
        })
        .collect();

    let numbers_preserved = missing_metrics.is_empty() && invented_metrics.is_empty();
    if !missing_metrics.is_empty() {
        let joined = missing_metrics
            .iter()
            .map(|m| m.raw.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        warnings.push(format!("Source number altered/dropped: {joined}"));
    }
    if !invented_metrics.is_empty() {
        let joined = invented_metrics
            .iter()
            .map(|m| m.raw.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        warnings.push(format!("Ungrounded number introduced: {joined}"));
    }

    let source_tokens = extract_code_and_url_tokens(source)?;
    let missing_tokens: Vec<&str> = source_tokens
        .iter()
        .map(String::as_str)
        .filter(|tok| !candidate.contains(tok))
        .collect();
    let tokens_preserved = missing_tokens.is_empty();
    if !tokens_preserved {
        warnings.push(format!(
            "Dropped code/URL token: {}",
            missing_tokens.join(", ")
        ));
    }

    let surface_violations = catalog.validate(candidate, surface_id)?;
    let surface_compliant =
        surface_violations.is_empty() && candidate.chars().count() <= profile.max_chars;
    for v in &surface_violations {
        warnings.push(v.message.clone());
    }

    let mut harper = HarperEngine::new(dialect_code, &Default::default(), user_words, "")?;
    let lints = harper.check_text(candidate);
    let grammar_clean = lints.is_empty();
    for lint in lints.iter().take(3) {
        warnings.push(format!("Harper ({}): {}", lint.rule, lint.message));
    }

    let secret_hits = scan_secrets(candidate);
    let secrets_free = secret_hits.is_empty();
    for hit in secret_hits.iter().take(3) {
        warnings.push(format!(
            "Contains sensitive {} ({})",
            hit.label, hit.masked_preview
        ));
    }

    Ok(GateCheckSummary {
        zero_slop,
        numbers_preserved,
        tokens_preserved,
        surface_compliant,
        grammar_clean,
        secrets_free,
        warnings,
    })
}

/// Apply zero-AI, deterministic safe text cleanup for slop phrases, em dashes, emojis, and hashtags.
/// Preserves Markdown fenced code blocks, inline backtick spans, and `> ` quote lines.
pub fn apply_safe_deterministic_fixes(
    text: &str,
    surface_id: &str,
    custom_slop: &[String],
    disabled_slop: &[String],
    custom_surfaces: &[SurfaceProfile],
) -> Result<SafeFixResult, CoreError> {
    let catalog = SurfaceCatalog::load_with_custom(custom_surfaces)?;
    let profile = catalog.get(surface_id)?;
    let scanner = SlopScanner::load_embedded()?;
    let mut current = text.to_owned();
    let mut fixes_applied = 0usize;
    let mut categories = Vec::new();

    let stripped_inv = crate::quality::strip_invisible_chars(&current);
    if stripped_inv.fixes_applied > 0 {
        current = stripped_inv.text;
        fixes_applied += stripped_inv.fixes_applied;
        categories.push("invisible_chars".to_owned());
    }

    if !profile.allow_em_dashes {
        let em_re = Regex::new(r"\s*—\s*|\s+--\s+")?;
        let ignored = ignored_prose_ranges(&current);
        let mut count = 0usize;
        let replaced = em_re.replace_all(&current, |caps: &regex::Captures<'_>| {
            let m = caps.get(0).expect("full match");
            if overlaps_ignored_ranges(m.start(), m.end(), &ignored) {
                m.as_str().to_owned()
            } else {
                count += 1;
                ", ".to_owned()
            }
        });
        if count > 0 {
            current = replaced.into_owned();
            fixes_applied += count;
            categories.push("em_dash".to_owned());
        }
    }

    let mut replacement_rules: Vec<(String, String)> = Vec::new();
    for raw in custom_slop {
        let (term, repl) = parse_custom_slop_entry(raw);
        if !term.is_empty()
            && let Some(r) = repl
            && !disabled_slop
                .iter()
                .any(|d| d.eq_ignore_ascii_case(term.trim()))
        {
            replacement_rules.push((term.to_owned(), r.to_owned()));
        }
    }
    replacement_rules.extend(scanner.safe_replacements_sorted());

    let mut slop_count = 0usize;
    for (phrase, replacement) in replacement_rules {
        let clean_key = phrase.trim_end();
        if disabled_slop
            .iter()
            .any(|d| d.eq_ignore_ascii_case(clean_key))
        {
            continue;
        }
        let trailing_space = if phrase.ends_with(' ') { r"\s*" } else { "" };
        let pattern = format!(r"(?i)\b{}{}", regex::escape(clean_key), trailing_space);
        let re = Regex::new(&pattern)?;
        let ignored = ignored_prose_ranges(&current);
        let mut matched_here = 0usize;
        let replaced = re.replace_all(&current, |caps: &regex::Captures<'_>| {
            let m = caps.get(0).expect("full match");
            if overlaps_ignored_ranges(m.start(), m.end(), &ignored) {
                m.as_str().to_owned()
            } else {
                matched_here += 1;
                preserve_case(m.as_str(), &replacement)
            }
        });
        if matched_here > 0 {
            current = replaced.into_owned();
            slop_count += matched_here;
        }
    }
    if slop_count > 0 {
        fixes_applied += slop_count;
        categories.push("slop".to_owned());
    }

    if !profile.allow_hashtags {
        let hashtag_re = Regex::new(r"(?:^|\s)#[a-zA-Z][a-zA-Z0-9_]{1,}")?;
        let ignored = ignored_prose_ranges(&current);
        let mut count = 0usize;
        let replaced = hashtag_re.replace_all(&current, |caps: &regex::Captures<'_>| {
            let m = caps.get(0).expect("full match");
            if overlaps_ignored_ranges(m.start(), m.end(), &ignored) {
                m.as_str().to_owned()
            } else {
                count += 1;
                String::new()
            }
        });
        if count > 0 {
            current = replaced.into_owned();
            fixes_applied += count;
            categories.push("hashtag".to_owned());
        }
    }

    if !profile.allow_emojis {
        let ignored = ignored_prose_ranges(&current);
        let mut cleaned = String::with_capacity(current.len());
        let mut emoji_count = 0usize;
        for (idx, ch) in current.char_indices() {
            let end = idx + ch.len_utf8();
            let cp = ch as u32;
            if matches!(cp, 0x1F300..=0x1FAFF | 0x2600..=0x27BF | 0x2300..=0x23FF)
                && !overlaps_ignored_ranges(idx, end, &ignored)
            {
                emoji_count += 1;
            } else {
                cleaned.push(ch);
            }
        }
        if emoji_count > 0 {
            current = cleaned;
            fixes_applied += emoji_count;
            categories.push("emoji".to_owned());
        }
    }

    if fixes_applied > 0 {
        let spaces_re = Regex::new(r"[ \t]{2,}")?;
        current = spaces_re.replace_all(&current, " ").trim().to_owned();
    }

    Ok(SafeFixResult {
        text: current,
        fixes_applied,
        categories,
    })
}

fn extract_unit_bound_metrics(text: &str) -> Result<Vec<UnitMetric>, CoreError> {
    let re = Regex::new(
        r"(?i)(?:^|[\s(\[])(#|\$)?(\d+(?:[.,]\d+)?)\s*(%|ms|s|sec|min|hrs?|kb|mb|gb|x|k|m|b)?(?:$|[\s,.;:!?/\)\]])",
    )?;
    let mut metrics = Vec::new();
    for caps in re.captures_iter(text) {
        let Some(num_match) = caps.get(2) else {
            continue;
        };
        let cleaned = num_match.as_str().replace(',', "");
        let Ok(value) = cleaned.parse::<f64>() else {
            continue;
        };
        let prefix = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let suffix = caps
            .get(3)
            .map(|m| m.as_str().to_ascii_lowercase())
            .unwrap_or_default();
        let unit = if !prefix.is_empty() {
            prefix.to_owned()
        } else if !suffix.is_empty() {
            suffix
        } else {
            "count".to_owned()
        };
        let raw = caps
            .get(0)
            .map(|m| {
                m.as_str()
                    .trim_matches(|c: char| c.is_whitespace() || "()[].,;:!?/".contains(c))
                    .to_owned()
            })
            .unwrap_or_default();
        metrics.push(UnitMetric { raw, value, unit });
    }
    Ok(metrics)
}

fn extract_code_and_url_tokens(text: &str) -> Result<Vec<String>, CoreError> {
    let backtick_re = Regex::new(r"`[^`\n]+`")?;
    let url_re = Regex::new(r"(?i)https?://[^\s)>\]]+")?;
    let mut tokens = Vec::new();
    for m in backtick_re.find_iter(text) {
        let s = m.as_str().to_owned();
        if !tokens.contains(&s) {
            tokens.push(s);
        }
    }
    for m in url_re.find_iter(text) {
        let s = m.as_str().to_owned();
        if !tokens.contains(&s) {
            tokens.push(s);
        }
    }
    Ok(tokens)
}
