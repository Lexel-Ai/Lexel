use std::fs;
use std::path::{Path, PathBuf};

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::harper::{RulePreset, preset_rule_overrides};
use crate::profile::{StyleGuideRule, UnifiedSettings};
use crate::surfaces::SurfaceViolation;

pub const REPO_CONFIG_FILENAMES: &[&str] = &[".lexel.toml", "lexel.toml"];

/// Repository-level commit message conventions loaded from `[commit]` in `.lexel.toml`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitConventions {
    #[serde(default)]
    pub allowed_types: Vec<String>,
    #[serde(default)]
    pub require_conventional: bool,
    #[serde(default = "default_true")]
    pub require_imperative: bool,
    #[serde(default = "default_max_subject_chars")]
    pub max_subject_chars: usize,
    #[serde(default = "default_max_body_line_chars")]
    pub max_body_line_chars: usize,
    #[serde(default = "default_true")]
    pub forbid_trailing_period: bool,
}

impl Default for CommitConventions {
    fn default() -> Self {
        Self {
            allowed_types: Vec::new(),
            require_conventional: false,
            require_imperative: true,
            max_subject_chars: default_max_subject_chars(),
            max_body_line_chars: default_max_body_line_chars(),
            forbid_trailing_period: true,
        }
    }
}

/// Repository-level documentation preferences loaded from `[docs]` in `.lexel.toml`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DocsConfig {
    #[serde(default)]
    pub tone: Option<String>,
    #[serde(default)]
    pub preset: Option<String>,
    #[serde(default)]
    pub max_line_chars: Option<usize>,
    #[serde(default)]
    pub max_sentence_words: Option<usize>,
    #[serde(default)]
    pub allow_em_dashes: Option<bool>,
}

/// Committable `.lexel.toml` repository configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepoConfig {
    #[serde(default)]
    pub dictionary: Vec<String>,
    #[serde(default)]
    pub banned_slop_terms: Vec<String>,
    #[serde(default)]
    pub allowed_slop_terms: Vec<String>,
    #[serde(default)]
    pub dialect: Option<String>,
    #[serde(default)]
    pub preset: Option<String>,
    #[serde(default)]
    pub style_guide: Vec<StyleGuideRule>,
    #[serde(default)]
    pub commit: CommitConventions,
    #[serde(default)]
    pub docs: DocsConfig,
}

fn default_true() -> bool {
    true
}

fn default_max_subject_chars() -> usize {
    72
}

fn default_max_body_line_chars() -> usize {
    100
}

impl RepoConfig {
    /// Discover `.lexel.toml` (or `lexel.toml`) by walking up from `start_path`.
    pub fn discover(start_path: &Path) -> Option<(PathBuf, Self)> {
        let mut dir = if start_path.is_file() {
            start_path.parent()?.to_path_buf()
        } else if start_path.is_dir() {
            start_path.to_path_buf()
        } else {
            start_path.parent()?.to_path_buf()
        };

        if let Ok(canon) = fs::canonicalize(&dir) {
            dir = canon;
        }

        loop {
            for filename in REPO_CONFIG_FILENAMES {
                let candidate = dir.join(filename);
                if candidate.is_file()
                    && let Ok(cfg) = Self::load_from_path(&candidate)
                {
                    return Some((candidate, cfg));
                }
            }
            if !dir.pop() {
                break;
            }
        }
        None
    }

    /// Load and parse a `.lexel.toml` file from disk.
    pub fn load_from_path(path: &Path) -> Result<Self, String> {
        let raw = fs::read_to_string(path)
            .map_err(|e| format!("failed to read {}: {e}", path.display()))?;
        Self::from_toml_str(&raw).map_err(|e| format!("invalid {}: {e}", path.display()))
    }

    /// Parse `.lexel.toml` content into a `RepoConfig`.
    pub fn from_toml_str(raw: &str) -> Result<Self, String> {
        let mut cfg = Self::default();
        let mut section = String::new();
        let mut current_style_rule: Option<StyleGuideRule> = None;

        let logical_lines = collapse_multiline_values(raw)?;
        for (line_no, line) in logical_lines {
            let trimmed = strip_toml_comment(&line).trim().to_owned();
            if trimmed.is_empty() {
                continue;
            }

            if trimmed.starts_with("[[") && trimmed.ends_with("]]") {
                if let Some(rule) = current_style_rule.take()
                    && !rule.term.is_empty()
                    && !rule.preferred.is_empty()
                {
                    cfg.style_guide.push(rule);
                }
                let name = trimmed[2..trimmed.len() - 2].trim().to_ascii_lowercase();
                if name == "style_guide" || name == "style-guide" {
                    section = "style_guide_item".to_owned();
                    current_style_rule = Some(StyleGuideRule {
                        term: String::new(),
                        preferred: String::new(),
                        case_sensitive: false,
                        note: None,
                    });
                } else {
                    section = name;
                }
                continue;
            }

            if trimmed.starts_with('[') && trimmed.ends_with(']') {
                if let Some(rule) = current_style_rule.take()
                    && !rule.term.is_empty()
                    && !rule.preferred.is_empty()
                {
                    cfg.style_guide.push(rule);
                }
                section = trimmed[1..trimmed.len() - 1].trim().to_ascii_lowercase();
                continue;
            }

            let Some((raw_key, raw_val)) = trimmed.split_once('=') else {
                return Err(format!("line {line_no}: expected `key = value`"));
            };
            let key = raw_key
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_ascii_lowercase();
            let val = raw_val.trim();

            match section.as_str() {
                "" => match key.as_str() {
                    "dictionary" => cfg.dictionary = parse_string_array(val, line_no)?,
                    "banned_slop_terms" | "banned_slop" => {
                        cfg.banned_slop_terms = parse_string_array(val, line_no)?;
                    }
                    "allowed_slop_terms" | "allowed_slop" => {
                        cfg.allowed_slop_terms = parse_string_array(val, line_no)?;
                    }
                    "dialect" => cfg.dialect = Some(parse_string(val, line_no)?),
                    "preset" => cfg.preset = Some(parse_string(val, line_no)?),
                    _ => {}
                },
                "commit" | "commits" => match key.as_str() {
                    "allowed_types" | "types" => {
                        cfg.commit.allowed_types = parse_string_array(val, line_no)?;
                    }
                    "require_conventional" => {
                        cfg.commit.require_conventional = parse_bool(val, line_no)?;
                    }
                    "require_imperative" => {
                        cfg.commit.require_imperative = parse_bool(val, line_no)?;
                    }
                    "max_subject_chars" | "subject_limit" => {
                        cfg.commit.max_subject_chars = parse_usize(val, line_no)?;
                    }
                    "max_body_line_chars" | "body_line_limit" | "line_limit" => {
                        cfg.commit.max_body_line_chars = parse_usize(val, line_no)?;
                    }
                    "forbid_trailing_period" => {
                        cfg.commit.forbid_trailing_period = parse_bool(val, line_no)?;
                    }
                    _ => {}
                },
                "docs" => match key.as_str() {
                    "tone" => cfg.docs.tone = Some(parse_string(val, line_no)?),
                    "preset" => cfg.docs.preset = Some(parse_string(val, line_no)?),
                    "max_line_chars" | "line_limit" => {
                        cfg.docs.max_line_chars = Some(parse_usize(val, line_no)?);
                    }
                    "max_sentence_words" => {
                        cfg.docs.max_sentence_words = Some(parse_usize(val, line_no)?);
                    }
                    "allow_em_dashes" => {
                        cfg.docs.allow_em_dashes = Some(parse_bool(val, line_no)?);
                    }
                    _ => {}
                },
                "style_guide_item" => {
                    if let Some(ref mut rule) = current_style_rule {
                        match key.as_str() {
                            "term" => rule.term = parse_string(val, line_no)?,
                            "preferred" => rule.preferred = parse_string(val, line_no)?,
                            "case_sensitive" => rule.case_sensitive = parse_bool(val, line_no)?,
                            "note" => rule.note = Some(parse_string(val, line_no)?),
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }

        if let Some(rule) = current_style_rule
            && !rule.term.is_empty()
            && !rule.preferred.is_empty()
        {
            cfg.style_guide.push(rule);
        }

        Ok(cfg)
    }

    /// Merge repository settings onto a profile's `UnifiedSettings` without mutating user defaults permanently.
    pub fn apply_to_settings(&self, settings: &mut UnifiedSettings) {
        for word in &self.dictionary {
            let trimmed = word.trim();
            if !trimmed.is_empty()
                && !settings
                    .user_dictionary
                    .iter()
                    .any(|w| w.eq_ignore_ascii_case(trimmed))
            {
                settings.user_dictionary.push(trimmed.to_owned());
            }
        }

        for term in &self.banned_slop_terms {
            let trimmed = term.trim();
            if !trimmed.is_empty()
                && !settings
                    .custom_slop_terms
                    .iter()
                    .any(|t| t.eq_ignore_ascii_case(trimmed))
            {
                settings.custom_slop_terms.push(trimmed.to_owned());
            }
        }

        for term in &self.allowed_slop_terms {
            let trimmed = term.trim();
            if !trimmed.is_empty()
                && !settings
                    .disabled_slop_terms
                    .iter()
                    .any(|t| t.eq_ignore_ascii_case(trimmed))
            {
                settings.disabled_slop_terms.push(trimmed.to_owned());
            }
        }

        for rule in &self.style_guide {
            if !settings
                .style_guide
                .iter()
                .any(|existing| existing.term.eq_ignore_ascii_case(&rule.term))
            {
                settings.style_guide.push(rule.clone());
            }
        }

        if let Some(ref dialect) = self.dialect
            && let Some(code) = parse_dialect_code(dialect)
        {
            settings.dialect = code;
        }

        let effective_preset = self.docs.preset.as_deref().or(self.preset.as_deref());
        if let Some(preset_name) = effective_preset
            && let Some(preset) = RulePreset::parse(preset_name)
        {
            for (k, v) in preset_rule_overrides(preset) {
                settings.lint_config.entry(k).or_insert(v);
            }
        }
    }

    /// Effective em-dash allowance for a surface when `.lexel.toml` overrides docs behavior.
    pub fn effective_allow_em_dashes(&self, surface_id: &str, profile_default: bool) -> bool {
        if surface_id == "docs_markdown"
            && let Some(allow) = self.docs.allow_em_dashes
        {
            return allow;
        }
        profile_default
    }

    /// Enforce repository-specific commit and documentation limits from `.lexel.toml`.
    pub fn validate_text(&self, text: &str, surface_id: &str) -> Vec<SurfaceViolation> {
        let mut violations = Vec::new();
        if surface_id == "ide_git_commit" {
            self.validate_commit_text(text, &mut violations);
        }
        if surface_id == "docs_markdown" || surface_id == "general" {
            self.validate_docs_text(text, &mut violations);
        }
        violations
    }

    /// Format concise repo-level instructions suitable for appending to local AI rewrite context.
    pub fn prompt_notes(&self, surface_id: &str) -> Option<String> {
        let mut parts = Vec::new();
        if surface_id == "ide_git_commit" {
            if !self.commit.allowed_types.is_empty() {
                parts.push(format!(
                    "Allowed commit types: {}",
                    self.commit.allowed_types.join(", ")
                ));
            }
            if self.commit.require_conventional {
                parts.push("Use Conventional Commits format: type(scope): summary.".to_owned());
            }
            parts.push(format!(
                "Keep commit subject <= {} chars and body lines <= {} chars.",
                self.commit.max_subject_chars, self.commit.max_body_line_chars
            ));
        } else if let Some(ref tone) = self.docs.tone {
            parts.push(format!("Repository docs tone: {tone}."));
        }

        if let Some(max_words) = self.docs.max_sentence_words {
            parts.push(format!("Keep sentences under {max_words} words."));
        }

        if parts.is_empty() {
            None
        } else {
            Some(parts.join(" "))
        }
    }

    fn validate_commit_text(&self, text: &str, violations: &mut Vec<SurfaceViolation>) {
        let commit_re = Regex::new(r"^([A-Za-z]+)(?:\(([^)]+)\))?(!)?:\s*(.*)$").ok();
        let mut offset = 0usize;
        let mut saw_subject = false;

        for line in text.split_inclusive('\n') {
            let content = line.trim_end_matches(['\r', '\n']);
            let trimmed = content.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                offset += line.len();
                continue;
            }

            if !saw_subject {
                saw_subject = true;
                let char_len = content.chars().count();
                if self.commit.max_subject_chars > 0 && char_len > self.commit.max_subject_chars {
                    let start_byte = char_index_to_byte(content, self.commit.max_subject_chars);
                    violations.push(SurfaceViolation {
                        kind: "repo_commit_subject_length".to_owned(),
                        message: format!(
                            ".lexel.toml requires commit subjects <= {} chars ({char_len} chars).",
                            self.commit.max_subject_chars
                        ),
                        start: offset + start_byte,
                        end: offset + content.len(),
                    });
                }

                if self.commit.forbid_trailing_period && content.ends_with('.') {
                    violations.push(SurfaceViolation {
                        kind: "repo_commit_subject_period".to_owned(),
                        message: ".lexel.toml forbids a trailing period on commit subjects."
                            .to_owned(),
                        start: offset + content.len().saturating_sub(1),
                        end: offset + content.len(),
                    });
                }

                let mut summary_part = content;
                let matched_prefix = commit_re.as_ref().and_then(|re| re.captures(content));
                if let Some(caps) = matched_prefix {
                    if let Some(type_m) = caps.get(1) {
                        let ctype = type_m.as_str();
                        if !self.commit.allowed_types.is_empty()
                            && !self.commit.allowed_types.iter().any(|t| t == ctype)
                        {
                            violations.push(SurfaceViolation {
                                kind: "repo_commit_type".to_owned(),
                                message: format!(
                                    "Commit type \"{ctype}\" is not in .lexel.toml allowed_types ({}).",
                                    self.commit.allowed_types.join(", ")
                                ),
                                start: offset + type_m.start(),
                                end: offset + type_m.end(),
                            });
                        }
                    }
                    if let Some(sum_m) = caps.get(4) {
                        summary_part = sum_m.as_str();
                    }
                } else if self.commit.require_conventional {
                    violations.push(SurfaceViolation {
                        kind: "repo_commit_conventional".to_owned(),
                        message: ".lexel.toml requires Conventional Commit format (`type(scope): summary`).".to_owned(),
                        start: offset,
                        end: offset + content.len(),
                    });
                }

                if self.commit.require_imperative {
                    let lower_summary = summary_part.trim_start().to_ascii_lowercase();
                    for past in [
                        "added ",
                        "fixed ",
                        "updated ",
                        "removed ",
                        "changed ",
                        "refactored ",
                    ] {
                        if lower_summary.starts_with(past) {
                            let past_start = offset
                                + content
                                    .len()
                                    .saturating_sub(summary_part.trim_start().len());
                            violations.push(SurfaceViolation {
                                kind: "repo_commit_mood".to_owned(),
                                message: ".lexel.toml requires imperative mood in commit subjects."
                                    .to_owned(),
                                start: past_start,
                                end: past_start + past.trim_end().len(),
                            });
                            break;
                        }
                    }
                }
            } else if self.commit.max_body_line_chars > 0 {
                let char_len = content.chars().count();
                if char_len > self.commit.max_body_line_chars
                    && !trimmed.starts_with("http://")
                    && !trimmed.starts_with("https://")
                {
                    let start_byte = char_index_to_byte(content, self.commit.max_body_line_chars);
                    violations.push(SurfaceViolation {
                        kind: "repo_commit_body_length".to_owned(),
                        message: format!(
                            ".lexel.toml requires commit body lines <= {} chars ({char_len} chars).",
                            self.commit.max_body_line_chars
                        ),
                        start: offset + start_byte,
                        end: offset + content.len(),
                    });
                }
            }

            offset += line.len();
        }
    }

    fn validate_docs_text(&self, text: &str, violations: &mut Vec<SurfaceViolation>) {
        let mut in_fence = false;
        let mut offset = 0usize;

        if let Some(max_line) = self.docs.max_line_chars
            && max_line > 0
        {
            for line in text.split_inclusive('\n') {
                let content = line.trim_end_matches(['\r', '\n']);
                let trimmed = content.trim_start();
                if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
                    in_fence = !in_fence;
                    offset += line.len();
                    continue;
                }
                if !in_fence {
                    let char_len = content.chars().count();
                    let is_table_or_url = trimmed.starts_with('|')
                        || trimmed.contains("http://")
                        || trimmed.contains("https://");
                    if char_len > max_line && !is_table_or_url {
                        let start_byte = char_index_to_byte(content, max_line);
                        violations.push(SurfaceViolation {
                            kind: "repo_docs_line_length".to_owned(),
                            message: format!(
                                ".lexel.toml docs.max_line_chars limit is {max_line} ({char_len} chars)."
                            ),
                            start: offset + start_byte,
                            end: offset + content.len(),
                        });
                    }
                }
                offset += line.len();
            }
        }

        if let Some(max_words) = self.docs.max_sentence_words
            && max_words > 0
        {
            let mut in_fence = false;
            let mut line_offset = 0usize;
            for line in text.split_inclusive('\n') {
                let content = line.trim_end_matches(['\r', '\n']);
                let trimmed = content.trim_start();
                if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
                    in_fence = !in_fence;
                    line_offset += line.len();
                    continue;
                }
                if !in_fence && !trimmed.is_empty() && !trimmed.starts_with('#') {
                    let mut sent_start = 0usize;
                    for (idx, ch) in content.char_indices() {
                        let is_end = matches!(ch, '.' | '!' | '?');
                        if is_end || idx + ch.len_utf8() == content.len() {
                            let end_byte = idx + ch.len_utf8();
                            let slice = content[sent_start..end_byte].trim();
                            let words = slice.split_whitespace().count();
                            if words > max_words {
                                violations.push(SurfaceViolation {
                                    kind: "repo_docs_sentence_length".to_owned(),
                                    message: format!(
                                        "Sentence has {words} words (.lexel.toml docs.max_sentence_words is {max_words})."
                                    ),
                                    start: line_offset + sent_start,
                                    end: line_offset + end_byte,
                                });
                            }
                            sent_start = end_byte;
                        }
                    }
                }
                line_offset += line.len();
            }
        }
    }
}

fn char_index_to_byte(s: &str, char_idx: usize) -> usize {
    s.char_indices()
        .nth(char_idx)
        .map(|(b, _)| b)
        .unwrap_or(s.len())
}

fn parse_dialect_code(raw: &str) -> Option<u8> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "us" | "american" | "en-us" | "0" => Some(0),
        "uk" | "british" | "en-gb" | "1" => Some(1),
        "au" | "australian" | "en-au" | "2" => Some(2),
        "ca" | "canadian" | "en-ca" | "3" => Some(3),
        "in" | "indian" | "en-in" | "4" => Some(4),
        _ => None,
    }
}

fn strip_toml_comment(line: &str) -> &str {
    let mut in_double = false;
    let mut in_single = false;
    let mut escaped = false;
    for (idx, ch) in line.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '\\' if in_double => escaped = true,
            '"' if !in_single => in_double = !in_double,
            '\'' if !in_double => in_single = !in_single,
            '#' if !in_double && !in_single => return &line[..idx],
            _ => {}
        }
    }
    line
}

fn collapse_multiline_values(raw: &str) -> Result<Vec<(usize, String)>, String> {
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut start_line = 0usize;
    let mut bracket_depth: i32 = 0;

    for (idx, raw_line) in raw.lines().enumerate() {
        let line_no = idx + 1;
        let clean = strip_toml_comment(raw_line).trim();
        if buf.is_empty() {
            if clean.is_empty() {
                continue;
            }
            start_line = line_no;
            buf.push_str(clean);
        } else {
            buf.push(' ');
            buf.push_str(clean);
        }

        // Update bracket depth outside quoted strings.
        let mut in_double = false;
        let mut in_single = false;
        let mut escaped = false;
        for ch in clean.chars() {
            if escaped {
                escaped = false;
                continue;
            }
            match ch {
                '\\' if in_double => escaped = true,
                '"' if !in_single => in_double = !in_double,
                '\'' if !in_double => in_single = !in_single,
                '[' if !in_double && !in_single => bracket_depth += 1,
                ']' if !in_double && !in_single => bracket_depth -= 1,
                _ => {}
            }
        }

        if bracket_depth <= 0 {
            bracket_depth = 0;
            out.push((start_line, std::mem::take(&mut buf)));
        }
    }

    if !buf.is_empty() {
        return Err(format!("line {start_line}: unclosed '[' array"));
    }

    Ok(out)
}

fn parse_string(raw: &str, line_no: usize) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
        serde_json::from_str::<String>(trimmed)
            .map_err(|e| format!("line {line_no}: invalid string literal: {e}"))
    } else if trimmed.starts_with('\'') && trimmed.ends_with('\'') && trimmed.len() >= 2 {
        Ok(trimmed[1..trimmed.len() - 1].to_owned())
    } else {
        Err(format!(
            "line {line_no}: expected quoted string, got `{trimmed}`"
        ))
    }
}

fn parse_bool(raw: &str, line_no: usize) -> Result<bool, String> {
    match raw.trim() {
        "true" => Ok(true),
        "false" => Ok(false),
        other => Err(format!("line {line_no}: expected boolean, got `{other}`")),
    }
}

fn parse_usize(raw: &str, line_no: usize) -> Result<usize, String> {
    let cleaned = raw.trim().replace('_', "");
    cleaned
        .parse::<usize>()
        .map_err(|_| format!("line {line_no}: expected unsigned integer, got `{raw}`"))
}

fn parse_string_array(raw: &str, line_no: usize) -> Result<Vec<String>, String> {
    let trimmed = raw.trim();
    if !trimmed.starts_with('[') || !trimmed.ends_with(']') {
        return Err(format!(
            "line {line_no}: expected array `[...]`, got `{trimmed}`"
        ));
    }
    let inner = trimmed[1..trimmed.len() - 1].trim();
    if inner.is_empty() {
        return Ok(Vec::new());
    }

    let mut items = Vec::new();
    let mut current = String::new();
    let mut in_double = false;
    let mut in_single = false;
    let mut escaped = false;

    for ch in inner.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        match ch {
            '\\' if in_double => {
                current.push(ch);
                escaped = true;
            }
            '"' if !in_single => {
                in_double = !in_double;
                current.push(ch);
            }
            '\'' if !in_double => {
                in_single = !in_single;
                current.push(ch);
            }
            ',' if !in_double && !in_single => {
                let token = current.trim();
                if !token.is_empty() {
                    items.push(parse_string(token, line_no)?);
                }
                current.clear();
            }
            _ => current.push(ch),
        }
    }

    let tail = current.trim();
    if !tail.is_empty() {
        items.push(parse_string(tail, line_no)?);
    }
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_repo_config_and_applies_to_settings() {
        let raw = r#"
# Project Lexel config
dialect = "uk"
preset = "strict_technical"
dictionary = [
  "Lexel",
  "Weirpack",
  "SimPO",
]
banned_slop_terms = ["synergize => combine", "bleeding-edge"]
allowed_slop_terms = ["robust"]

[commit]
allowed_types = ["feat", "fix", "perf", "docs"]
require_conventional = true
require_imperative = true
max_subject_chars = 64
max_body_line_chars = 90
forbid_trailing_period = true

[docs]
tone = "direct technical"
max_line_chars = 100
max_sentence_words = 25
allow_em_dashes = false

[[style_guide]]
term = "postgres"
preferred = "PostgreSQL"
note = "Use full product name"
"#;

        let cfg = RepoConfig::from_toml_str(raw).expect("valid toml");
        assert_eq!(cfg.dictionary, vec!["Lexel", "Weirpack", "SimPO"]);
        assert_eq!(cfg.banned_slop_terms.len(), 2);
        assert_eq!(cfg.allowed_slop_terms, vec!["robust"]);
        assert_eq!(cfg.commit.max_subject_chars, 64);
        assert_eq!(cfg.commit.max_body_line_chars, 90);
        assert!(cfg.commit.require_conventional);
        assert_eq!(cfg.docs.tone.as_deref(), Some("direct technical"));
        assert_eq!(cfg.docs.max_line_chars, Some(100));
        assert_eq!(cfg.docs.max_sentence_words, Some(25));
        assert_eq!(cfg.style_guide.len(), 1);
        assert_eq!(cfg.style_guide[0].preferred, "PostgreSQL");

        let mut settings = UnifiedSettings::default();
        cfg.apply_to_settings(&mut settings);
        assert_eq!(settings.dialect, 1);
        assert!(settings.user_dictionary.contains(&"Weirpack".to_owned()));
        assert!(
            settings
                .custom_slop_terms
                .contains(&"synergize => combine".to_owned())
        );
        assert!(settings.disabled_slop_terms.contains(&"robust".to_owned()));
        assert_eq!(settings.style_guide.len(), 1);

        let commit_violations = cfg.validate_text(
            "chore(core): added a very long commit subject line that definitely exceeds sixty four chars.",
            "ide_git_commit",
        );
        assert!(
            commit_violations
                .iter()
                .any(|v| v.kind == "repo_commit_type")
        );
        assert!(
            commit_violations
                .iter()
                .any(|v| v.kind == "repo_commit_subject_length")
        );
        assert!(
            commit_violations
                .iter()
                .any(|v| v.kind == "repo_commit_subject_period")
        );
        assert!(
            commit_violations
                .iter()
                .any(|v| v.kind == "repo_commit_mood")
        );

        let docs_violations = cfg.validate_text(
            "This line has way more than one hundred characters in total so it should trigger the repository line length rule cleanly.",
            "docs_markdown",
        );
        assert!(
            docs_violations
                .iter()
                .any(|v| v.kind == "repo_docs_line_length")
        );
    }

    #[test]
    fn discovers_lexel_toml_walking_up_directories() {
        let base = std::env::temp_dir().join(format!("lexel-repo-cfg-{}", std::process::id()));
        let nested = base.join("a").join("b");
        fs::create_dir_all(&nested).expect("mkdir");
        fs::write(base.join(".lexel.toml"), "dictionary = [\"LexelCore\"]\n")
            .expect("write config");
        let file = nested.join("README.md");
        fs::write(&file, "# Hello\n").expect("write readme");

        let (found_path, found_cfg) = RepoConfig::discover(&file).expect("discovered config");
        assert!(found_path.ends_with(".lexel.toml"));
        assert_eq!(found_cfg.dictionary, vec!["LexelCore"]);

        let _ = fs::remove_dir_all(&base);
    }
}
