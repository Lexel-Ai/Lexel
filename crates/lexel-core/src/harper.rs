use std::collections::BTreeMap;
use std::sync::Arc;

use harper_core::linting::{
    FlatConfig, HumanReadableStructuredConfig, LintGroup, StructuredConfig,
};
use harper_core::parsers::{MarkdownOptions, OrgMode, PlainEnglish};
use harper_core::spell::{FstDictionary, MergedDictionary, MutableDictionary};
use harper_core::weirpack::Weirpack;
use harper_core::{Dialect, DictWordMetadata, Document, IgnoredLints, make_title_case_str};
use serde::{Deserialize, Serialize};

use crate::CoreError;

/// Summary returned after validating an uploaded `.weirpack` archive.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WeirpackValidationSummary {
    pub rule_count: usize,
    pub rule_names: Vec<String>,
    pub has_dictionary: bool,
    pub failures: BTreeMap<String, usize>,
}

/// Metadata for one Harper grammar/spelling rule.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarperRuleInfo {
    pub id: String,
    pub enabled: bool,
    pub default_enabled: bool,
    pub description: String,
}

/// Diagnostic returned by running Harper over plain English text.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarperDiagnostic {
    pub rule: String,
    pub lint_kind: String,
    pub message: String,
    pub problem_text: String,
    pub start: usize,
    pub end: usize,
    pub suggestions: Vec<String>,
}

/// Thin wrapper over `harper_core` supporting curated rules, custom dictionary,
/// ignored lint hashes, and full rule inspection.
pub struct HarperEngine {
    dialect: Dialect,
    group: LintGroup,
    dictionary: Arc<MergedDictionary>,
    ignored: IgnoredLints,
}

impl HarperEngine {
    /// Construct a Harper engine for the given dialect, rule overrides, user words, and ignored lints.
    pub fn new(
        dialect_code: u8,
        rule_overrides: &BTreeMap<String, Option<bool>>,
        user_words: &[String],
        ignored_lints_json: &str,
    ) -> Result<Self, CoreError> {
        let dialect = match dialect_code {
            1 => Dialect::British,
            2 => Dialect::Australian,
            3 => Dialect::Canadian,
            4 => Dialect::Indian,
            _ => Dialect::American,
        };

        let mut merged = MergedDictionary::new();
        merged.add_dictionary(FstDictionary::curated());

        if !user_words.is_empty() {
            let mut user_dict = MutableDictionary::new();
            for word in user_words {
                let trimmed = word.trim();
                if !trimmed.is_empty() {
                    user_dict.append_word_str(trimmed, DictWordMetadata::default());
                }
            }
            merged.add_dictionary(Arc::new(user_dict));
        }

        let dictionary = Arc::new(merged);
        let mut group = LintGroup::new_curated(dictionary.clone(), dialect);

        if !rule_overrides.is_empty() {
            let json = serde_json::to_string(rule_overrides)?;
            let overrides: FlatConfig = serde_json::from_str(&json)
                .map_err(|err| CoreError::InvalidLintConfig(err.to_string()))?;
            group.config.merge_from(overrides);
        }

        let ignored = if ignored_lints_json.trim().is_empty() {
            IgnoredLints::new()
        } else {
            serde_json::from_str(ignored_lints_json).unwrap_or_default()
        };

        Ok(Self {
            dialect,
            group,
            dictionary,
            ignored,
        })
    }

    /// Return every Harper curated rule with its effective state, default state, and description.
    pub fn rule_catalog(&self) -> Vec<HarperRuleInfo> {
        let defaults = FlatConfig::new_curated();
        let descriptions = self.group.all_descriptions();
        let mut rules = Vec::with_capacity(descriptions.len());

        for (id, desc) in descriptions {
            rules.push(HarperRuleInfo {
                id: id.to_owned(),
                enabled: self.group.config.is_rule_enabled(id),
                default_enabled: defaults.is_rule_enabled(id),
                description: desc.to_owned(),
            });
        }

        rules.sort_by(|a, b| a.id.cmp(&b.id));
        rules
    }

    /// Run all enabled Harper rules over `text` using plain English parsing.
    pub fn check_text(&mut self, text: &str) -> Vec<HarperDiagnostic> {
        self.check_text_with_language(text, "plaintext")
    }

    /// Run all enabled Harper rules over `text` with parser selected by `language` (`plaintext` | `markdown` | `org`).
    pub fn check_text_with_language(
        &mut self,
        text: &str,
        language: &str,
    ) -> Vec<HarperDiagnostic> {
        if text.trim().is_empty() {
            return Vec::new();
        }
        let doc = match language.to_ascii_lowercase().as_str() {
            "markdown" | "md" => Document::new_markdown_default(text, self.dictionary.as_ref()),
            "org" | "org_mode" => Document::new_curated(text, &OrgMode),
            _ => Document::new_plain_english(text, self.dictionary.as_ref()),
        };
        let source = doc.get_source();
        let organized = self.group.organized_lints(&doc);
        let mut out = Vec::new();

        for (rule, mut lints) in organized {
            self.ignored.remove_ignored(&mut lints, &doc);
            for lint in lints {
                out.push(HarperDiagnostic {
                    rule: rule.clone(),
                    lint_kind: lint.lint_kind.to_string(),
                    message: lint.message.clone(),
                    problem_text: lint.get_str(source),
                    start: lint.span.start,
                    end: lint.span.end,
                    suggestions: lint
                        .suggestions
                        .iter()
                        .take(3)
                        .map(|s| s.to_string())
                        .collect(),
                });
            }
        }

        let _ = (self.dialect, MarkdownOptions::default());
        out.sort_by_key(|d| (d.start, d.end));
        out
    }
}

/// Convert `text` to Chicago-style title case using Harper's built-in dictionary rules.
pub fn to_title_case(text: &str) -> String {
    let dict = FstDictionary::curated();
    make_title_case_str(text, &PlainEnglish, dict.as_ref())
}

/// Return frequency-sorted English synonyms from `harper-thesaurus`.
pub fn synonyms_for(word: &str) -> Vec<String> {
    let trimmed = word.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    harper_thesaurus::thesaurus()
        .get_synonyms_freq_sorted(trimmed)
        .unwrap_or_default()
        .into_iter()
        .take(16)
        .map(str::to_owned)
        .collect()
}

/// Return Harper's curated grouped rule hierarchy for structured UI settings.
pub fn structured_lint_config() -> HumanReadableStructuredConfig {
    HumanReadableStructuredConfig::from_structured_config(&StructuredConfig::curated())
}

/// Parse and run embedded Weir unit tests inside a `.weirpack` archive.
pub fn validate_weirpack_bytes(bytes: &[u8]) -> Result<WeirpackValidationSummary, CoreError> {
    let pack =
        Weirpack::from_bytes(bytes).map_err(|err| CoreError::InvalidLintConfig(err.to_string()))?;
    let test_results = pack
        .run_tests()
        .map_err(|err| CoreError::InvalidLintConfig(err.to_string()))?;

    let mut rule_names: Vec<String> = pack.rules.keys().cloned().collect();
    rule_names.sort();

    let mut failures = BTreeMap::new();
    for (rule, results) in test_results {
        if !results.is_empty() {
            failures.insert(rule, results.len());
        }
    }

    Ok(WeirpackValidationSummary {
        rule_count: rule_names.len(),
        rule_names,
        has_dictionary: pack.dictionary.is_some(),
        failures,
    })
}
