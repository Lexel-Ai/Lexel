use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use harper_asciidoc::AsciidocParser;
use harper_comments::CommentParser;
use harper_core::linting::{
    FlatConfig, HumanReadableStructuredConfig, LintGroup, LintKind, StructuredConfig,
};
use harper_core::parsers::{CollapseIdentifiers, MarkdownOptions, OrgMode, PlainEnglish};
use harper_core::spell::{FstDictionary, MergedDictionary, MutableDictionary};
use harper_core::weirpack::{Weirpack, WeirpackManifest};
use harper_core::{Dialect, DictWordMetadata, Document, IgnoredLints, make_title_case_str};
use harper_git_commit::GitCommitParser;
use harper_html::HtmlParser;
use harper_python::PythonParser;
use harper_tex::TeX;
use harper_typst::Typst;
use serde::{Deserialize, Serialize};

use crate::{CoreError, SafeFixResult, StoredWeirpack};

/// Curated Harper rule presets that tune deterministic checks without loading any LLM.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RulePreset {
    #[default]
    Curated,
    StrictTechnical,
    FormalAcademic,
    CasualChat,
}

impl RulePreset {
    /// Parse a preset identifier from CLI/API strings.
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "curated" | "default" => Some(Self::Curated),
            "strict_technical" | "strict-technical" | "technical" | "strict" => {
                Some(Self::StrictTechnical)
            }
            "formal_academic" | "formal-academic" | "formal" | "academic" => {
                Some(Self::FormalAcademic)
            }
            "casual_chat" | "casual-chat" | "casual" | "chat" => Some(Self::CasualChat),
            _ => None,
        }
    }
}

/// Return Harper `FlatConfig` rule overrides for the chosen deterministic preset.
pub fn preset_rule_overrides(preset: RulePreset) -> BTreeMap<String, Option<bool>> {
    let mut map = BTreeMap::new();
    match preset {
        RulePreset::Curated => {}
        RulePreset::StrictTechnical => {
            for rule in [
                "BoringWords",
                "FillerWords",
                "Hedging",
                "LongSentences",
                "RepeatedWords",
                "AvoidCurses",
                "OxfordComma",
            ] {
                map.insert(rule.to_owned(), Some(true));
            }
            map.insert("NoOxfordComma".to_owned(), Some(false));
        }
        RulePreset::FormalAcademic => {
            for rule in [
                "AvoidContractions",
                "BoringWords",
                "FillerWords",
                "Hedging",
                "LongSentences",
                "RepeatedWords",
                "AvoidCurses",
                "SpelledNumbers",
                "OxfordComma",
            ] {
                map.insert(rule.to_owned(), Some(true));
            }
            map.insert("NoOxfordComma".to_owned(), Some(false));
        }
        RulePreset::CasualChat => {
            for rule in [
                "LongSentences",
                "SentenceCapitalization",
                "AvoidCurses",
                "AvoidContractions",
            ] {
                map.insert(rule.to_owned(), Some(false));
            }
        }
    }
    map
}

/// Offline readability and sentence complexity report computed without any LLM.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadabilityReport {
    pub chars: usize,
    pub words: usize,
    pub sentences: usize,
    pub syllables: usize,
    pub long_sentences: usize,
    pub avg_words_per_sentence: f64,
    pub reading_time_sec: usize,
    pub speaking_time_sec: usize,
    pub flesch_reading_ease: f64,
    pub flesch_kincaid_grade: f64,
    pub passive_voice_count: usize,
    pub hedging_count: usize,
    pub hedging_percent: f64,
    pub sentence_variety_score: usize,
}

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

/// Diagnostic returned by running Harper over text or source code comments.
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

/// Infer a Lexel/Harper language ID from a file path or filename.
pub fn detect_language_from_path(path: &Path) -> &'static str {
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        let lower_name = name.to_ascii_lowercase();
        if matches!(
            lower_name.as_str(),
            "commit_editmsg" | "merge_msg" | "tag_editmsg" | "git_rebase_todo"
        ) {
            return "git-commit";
        }
        if lower_name == "cmakelists.txt" {
            return "cmake";
        }
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "md" | "mdx" | "markdown" => "markdown",
        "org" => "org",
        "html" | "htm" => "html",
        "tex" | "latex" | "sty" => "tex",
        "typ" => "typst",
        "adoc" | "asciidoc" => "asciidoc",
        "py" | "pyi" => "python",
        "rs" => "rust",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "typescriptreact",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "javascriptreact",
        "go" => "go",
        "c" => "c",
        "h" | "hpp" | "hh" | "cpp" | "cc" | "cxx" => "cpp",
        "cs" => "csharp",
        "java" => "java",
        "rb" => "ruby",
        "php" => "php",
        "swift" => "swift",
        "kt" | "kts" => "kotlin",
        "scala" => "scala",
        "lua" => "lua",
        "nix" => "nix",
        "sh" | "bash" | "zsh" => "shellscript",
        "ps1" => "powershell",
        "zig" => "zig",
        "gleam" => "gleam",
        "ex" | "exs" => "elixir",
        "hs" => "haskell",
        "dart" => "dart",
        "sol" => "solidity",
        "toml" => "toml",
        "r" => "r",
        "clj" | "cljs" => "clojure",
        _ => "plaintext",
    }
}

/// Thin wrapper over `harper_core` supporting curated rules, custom dictionary,
/// multi-language parsers, `.weirpack` loading, ignored lint hashes, and safe batch fixes.
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

    /// Parse and merge a `.weirpack` archive into this engine after verifying its embedded tests pass.
    pub fn add_weirpack_bytes(
        &mut self,
        bytes: &[u8],
    ) -> Result<WeirpackValidationSummary, CoreError> {
        let pack = Weirpack::from_bytes(bytes)
            .map_err(|err| CoreError::InvalidLintConfig(err.to_string()))?;
        let summary = summarize_weirpack(&pack)?;
        if !summary.failures.is_empty() {
            return Err(CoreError::InvalidLintConfig(format!(
                "Weirpack failed {} embedded rule test(s)",
                summary.failures.len()
            )));
        }
        let pack_group = pack
            .to_lint_group()
            .map_err(|err| CoreError::InvalidLintConfig(err.to_string()))?;
        self.group.merge_from(pack_group);
        Ok(summary)
    }

    /// Merge all enabled user-synced `.weirpack` archives into this engine, skipping invalid entries.
    pub fn load_stored_weirpacks(&mut self, packs: &[StoredWeirpack]) {
        for pack in packs {
            if !pack.enabled || pack.bytes_base64.trim().is_empty() {
                continue;
            }
            if let Ok(bytes) = decode_weirpack_base64(&pack.bytes_base64) {
                let _ = self.add_weirpack_bytes(&bytes);
            }
        }
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

    /// Run all enabled Harper rules over `text` with parser selected by `language`
    /// (`plaintext` | `markdown` | `org` | `html` | `tex` | `typst` | `asciidoc` | `python` | `git-commit` | code language ID).
    pub fn check_text_with_language(
        &mut self,
        text: &str,
        language: &str,
    ) -> Vec<HarperDiagnostic> {
        if text.trim().is_empty() {
            return Vec::new();
        }
        let (doc, extra_dict) = self.build_document(text, language);
        let source = doc.get_source();
        let organized = if let Some(temp_dict) = extra_dict {
            let mut temp_group = LintGroup::new_curated(temp_dict, self.dialect);
            temp_group.config = self.group.config.clone();
            temp_group.organized_lints(&doc)
        } else {
            self.group.organized_lints(&doc)
        };
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

        out.sort_by_key(|d| (d.start, d.end));
        out
    }

    /// Deterministically apply all non-overlapping, single-suggestion safe Harper fixes in reverse span order.
    pub fn apply_safe_harper_fixes(&mut self, text: &str, language: &str) -> SafeFixResult {
        if text.trim().is_empty() {
            return SafeFixResult {
                text: text.to_owned(),
                fixes_applied: 0,
                categories: Vec::new(),
            };
        }

        let (doc, extra_dict) = self.build_document(text, language);
        let organized = if let Some(temp_dict) = extra_dict {
            let mut temp_group = LintGroup::new_curated(temp_dict, self.dialect);
            temp_group.config = self.group.config.clone();
            temp_group.organized_lints(&doc)
        } else {
            self.group.organized_lints(&doc)
        };

        let mut candidates = Vec::new();
        for (_rule, mut lints) in organized {
            self.ignored.remove_ignored(&mut lints, &doc);
            for lint in lints {
                if lint.suggestions.len() == 1 && is_safe_batch_kind(lint.lint_kind) {
                    candidates.push(lint);
                }
            }
        }

        candidates.sort_by_key(|l| (l.span.start, l.span.end));
        let mut selected = Vec::with_capacity(candidates.len());
        let mut last_end = 0usize;
        for lint in candidates {
            if lint.span.start >= last_end {
                last_end = lint.span.end;
                selected.push(lint);
            }
        }

        if selected.is_empty() {
            return SafeFixResult {
                text: text.to_owned(),
                fixes_applied: 0,
                categories: Vec::new(),
            };
        }

        let mut chars: Vec<char> = text.chars().collect();
        let fixes_applied = selected.len();
        for lint in selected.into_iter().rev() {
            if let Some(suggestion) = lint.suggestions.first()
                && lint.span.end <= chars.len()
            {
                suggestion.apply(lint.span, &mut chars);
            }
        }

        SafeFixResult {
            text: chars.into_iter().collect(),
            fixes_applied,
            categories: vec!["harper_safe".to_owned()],
        }
    }

    fn build_document(
        &self,
        text: &str,
        language: &str,
    ) -> (Document, Option<Arc<MergedDictionary>>) {
        let normalized = normalize_language_alias(language);
        match normalized {
            "markdown" => (
                Document::new_markdown_default(text, self.dictionary.as_ref()),
                None,
            ),
            "org" => (
                Document::new(text, &OrgMode, self.dictionary.as_ref()),
                None,
            ),
            "html" => (
                Document::new(text, &HtmlParser::default(), self.dictionary.as_ref()),
                None,
            ),
            "tex" => (
                Document::new(text, &TeX::default(), self.dictionary.as_ref()),
                None,
            ),
            "typst" => (Document::new(text, &Typst, self.dictionary.as_ref()), None),
            "asciidoc" => (
                Document::new(text, &AsciidocParser::default(), self.dictionary.as_ref()),
                None,
            ),
            "python" => (
                Document::new(text, &PythonParser::default(), self.dictionary.as_ref()),
                None,
            ),
            "git-commit" => (
                Document::new(text, &GitCommitParser::default(), self.dictionary.as_ref()),
                None,
            ),
            other => {
                if let Some(comment_parser) =
                    CommentParser::new_from_language_id(other, MarkdownOptions::default())
                {
                    let source_chars: Vec<char> = text.chars().collect();
                    if let Some(ident_dict) = comment_parser.create_ident_dict(&source_chars) {
                        let mut merged = MergedDictionary::new();
                        merged.add_dictionary(self.dictionary.clone());
                        merged.add_dictionary(Arc::new(ident_dict));
                        let merged_arc = Arc::new(merged);
                        let collapsed = CollapseIdentifiers::new(
                            Box::new(comment_parser),
                            Box::new(merged_arc.clone() as Arc<dyn harper_core::spell::Dictionary>),
                        );
                        return (
                            Document::new(text, &collapsed, merged_arc.as_ref()),
                            Some(merged_arc),
                        );
                    }
                    return (
                        Document::new(text, &comment_parser, self.dictionary.as_ref()),
                        None,
                    );
                }
                (
                    Document::new_plain_english(text, self.dictionary.as_ref()),
                    None,
                )
            }
        }
    }
}

fn normalize_language_alias(language: &str) -> &str {
    match language.trim().to_ascii_lowercase().as_str() {
        "markdown" | "md" | "mdx" => "markdown",
        "org" | "org_mode" => "org",
        "html" | "htm" => "html",
        "tex" | "latex" => "tex",
        "typ" | "typst" => "typst",
        "adoc" | "asciidoc" => "asciidoc",
        "py" | "python" => "python",
        "git-commit" | "gitcommit" | "scminput" => "git-commit",
        "rs" | "rust" => "rust",
        "ts" | "typescript" => "typescript",
        "tsx" | "typescriptreact" => "typescriptreact",
        "js" | "javascript" => "javascript",
        "jsx" | "javascriptreact" => "javascriptreact",
        "sh" | "bash" | "zsh" | "shellscript" => "shellscript",
        "cs" | "csharp" => "csharp",
        "kt" | "kotlin" => "kotlin",
        "go" => "go",
        "c" => "c",
        "cpp" | "cc" | "cxx" => "cpp",
        "java" => "java",
        "rb" | "ruby" => "ruby",
        "php" => "php",
        "swift" => "swift",
        "scala" => "scala",
        "lua" => "lua",
        "nix" => "nix",
        "powershell" | "ps1" => "powershell",
        "zig" => "zig",
        "gleam" => "gleam",
        "elixir" | "ex" => "elixir",
        "haskell" | "hs" => "haskell",
        "dart" => "dart",
        "solidity" | "sol" => "solidity",
        "toml" => "toml",
        "r" => "r",
        "clojure" | "clj" => "clojure",
        "cmake" => "cmake",
        "groovy" => "groovy",
        _ => "plaintext",
    }
}

fn is_safe_batch_kind(kind: LintKind) -> bool {
    matches!(
        kind,
        LintKind::Agreement
            | LintKind::BoundaryError
            | LintKind::Capitalization
            | LintKind::Formatting
            | LintKind::Grammar
            | LintKind::Miscellaneous
            | LintKind::Nonstandard
            | LintKind::Punctuation
            | LintKind::Redundancy
            | LintKind::Repetition
            | LintKind::Spelling
            | LintKind::Typo
            | LintKind::Usage
            | LintKind::WordChoice
    )
}

/// Convert `text` to Chicago-style title case using Harper's built-in dictionary rules.
pub fn to_title_case(text: &str) -> String {
    let dict = FstDictionary::curated();
    make_title_case_str(text, &PlainEnglish, dict.as_ref())
}

/// Convert `text` deterministically to sentence case while preserving code blocks, inline code, URLs, and short acronyms.
pub fn to_sentence_case(text: &str) -> String {
    let ignored = crate::slop::ignored_prose_ranges(text);
    let mut prose_has_lowercase = false;
    let mut check_cursor = 0usize;
    for &(r_start, r_end) in &ignored {
        if r_start > check_cursor
            && text[check_cursor..r_start]
                .chars()
                .any(|c| c.is_lowercase())
        {
            prose_has_lowercase = true;
            break;
        }
        check_cursor = r_end;
    }
    if !prose_has_lowercase && text[check_cursor..].chars().any(|c| c.is_lowercase()) {
        prose_has_lowercase = true;
    }

    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    let mut at_sentence_start = true;

    for (r_start, r_end) in ignored
        .into_iter()
        .chain(std::iter::once((text.len(), text.len())))
    {
        if r_start > cursor {
            let (converted, next_start) = sentence_case_segment(
                &text[cursor..r_start],
                prose_has_lowercase,
                at_sentence_start,
            );
            out.push_str(&converted);
            at_sentence_start = next_start;
        }
        if r_end > r_start {
            let skipped = &text[r_start..r_end];
            out.push_str(skipped);
            if skipped.starts_with("```") || skipped.trim_start().starts_with('>') {
                at_sentence_start = true;
            }
        }
        cursor = r_end;
    }
    out
}

fn sentence_case_segment(
    segment: &str,
    has_lowercase: bool,
    initial_sentence_start: bool,
) -> (String, bool) {
    let mut out = String::with_capacity(segment.len());
    let mut at_sentence_start = initial_sentence_start;
    let mut chars = segment.char_indices().peekable();

    while let Some((idx, ch)) = chars.peek().copied() {
        if ch.is_whitespace() {
            let start = idx;
            let mut blank_break = false;
            let mut newline_count = 0usize;
            while let Some(&(_, w)) = chars.peek() {
                if !w.is_whitespace() {
                    break;
                }
                if w == '\n' {
                    newline_count += 1;
                    if newline_count >= 2 {
                        blank_break = true;
                    }
                }
                chars.next();
            }
            let end = chars.peek().map(|&(i, _)| i).unwrap_or(segment.len());
            out.push_str(&segment[start..end]);
            if blank_break {
                at_sentence_start = true;
            }
            continue;
        }

        let start = idx;
        while let Some(&(_, w)) = chars.peek() {
            if w.is_whitespace() {
                break;
            }
            chars.next();
        }
        let end = chars.peek().map(|&(i, _)| i).unwrap_or(segment.len());
        let token = &segment[start..end];

        let ends_sentence = token
            .trim_end_matches(['"', '\'', ')', ']'])
            .ends_with(['.', '!', '?']);

        let lower_tok = token.to_ascii_lowercase();
        if lower_tok.starts_with("http://") || lower_tok.starts_with("https://") {
            out.push_str(token);
            at_sentence_start = ends_sentence;
            continue;
        }

        let alpha: Vec<char> = token.chars().filter(|c| c.is_alphabetic()).collect();
        let is_short_acronym = has_lowercase
            && (2..=5).contains(&alpha.len())
            && alpha.iter().all(|c| c.is_uppercase());

        if is_short_acronym || alpha.is_empty() {
            out.push_str(token);
        } else {
            let mut capitalized_word = !at_sentence_start;
            for c in token.chars() {
                if c.is_alphabetic() {
                    if !capitalized_word {
                        for u in c.to_uppercase() {
                            out.push(u);
                        }
                        capitalized_word = true;
                    } else {
                        for l in c.to_lowercase() {
                            out.push(l);
                        }
                    }
                } else {
                    out.push(c);
                }
            }
        }
        at_sentence_start = ends_sentence;
    }

    (out, at_sentence_start)
}

/// Deterministically normalize curly quotes, ellipses, non-breaking spaces, invisible Unicode watermarks, and redundant inline spaces outside code/quote blocks.
pub fn normalize_typography(text: &str) -> SafeFixResult {
    let stripped = crate::quality::strip_invisible_chars(text);
    let working = stripped.text.as_str();
    let ignored = crate::slop::ignored_prose_ranges(working);
    let mut fixes = stripped.fixes_applied;
    let mut categories = stripped.categories;
    let mut quote_fixes = 0usize;
    let mut ellipsis_fixes = 0usize;
    let mut space_fixes = 0usize;
    let mut rebuilt = String::with_capacity(working.len());
    let mut cursor = 0usize;

    for (r_start, r_end) in ignored
        .into_iter()
        .chain(std::iter::once((working.len(), working.len())))
    {
        if r_start > cursor {
            let segment = &working[cursor..r_start];
            let mut quote_normalized = String::with_capacity(segment.len());
            for ch in segment.chars() {
                match ch {
                    '“' | '”' => {
                        quote_normalized.push('"');
                        quote_fixes += 1;
                    }
                    '‘' | '’' => {
                        quote_normalized.push('\'');
                        quote_fixes += 1;
                    }
                    '…' => {
                        quote_normalized.push_str("...");
                        ellipsis_fixes += 1;
                    }
                    '\u{00A0}' => {
                        quote_normalized.push(' ');
                        space_fixes += 1;
                    }
                    _ => quote_normalized.push(ch),
                }
            }

            let mut lines_out = Vec::new();
            for line in quote_normalized.split('\n') {
                let trimmed_end = line.trim_end_matches([' ', '\t']);
                if trimmed_end.len() != line.len() {
                    space_fixes += 1;
                }
                let leading_ws_len = trimmed_end
                    .find(|c: char| c != ' ' && c != '\t')
                    .unwrap_or(trimmed_end.len());
                let (indent, rest) = trimmed_end.split_at(leading_ws_len);
                let mut collapsed = String::with_capacity(trimmed_end.len());
                collapsed.push_str(indent);
                let mut prev_space = false;
                for ch in rest.chars() {
                    if ch == ' ' || ch == '\t' {
                        if prev_space {
                            space_fixes += 1;
                        } else {
                            collapsed.push(' ');
                            prev_space = true;
                        }
                    } else {
                        collapsed.push(ch);
                        prev_space = false;
                    }
                }
                lines_out.push(collapsed);
            }
            rebuilt.push_str(&lines_out.join("\n"));
        }
        if r_end > r_start {
            rebuilt.push_str(&working[r_start..r_end]);
        }
        cursor = r_end;
    }

    if quote_fixes > 0 {
        fixes += quote_fixes;
        categories.push("quotes".to_owned());
    }
    if ellipsis_fixes > 0 {
        fixes += ellipsis_fixes;
        categories.push("typography".to_owned());
    }
    if space_fixes > 0 {
        fixes += space_fixes;
        categories.push("whitespace".to_owned());
    }

    SafeFixResult {
        text: rebuilt,
        fixes_applied: fixes,
        categories,
    }
}

/// Compute offline Flesch-Kincaid readability and sentence metrics without AI.
pub fn analyze_readability(text: &str) -> ReadabilityReport {
    let chars = text.chars().count();
    let mut words = 0usize;
    let mut syllables = 0usize;
    for raw in text.split_whitespace() {
        let alpha: String = raw
            .chars()
            .filter(|c| c.is_ascii_alphabetic())
            .collect::<String>()
            .to_ascii_lowercase();
        if !alpha.is_empty() || raw.chars().any(|c| c.is_alphanumeric()) {
            words += 1;
            syllables += count_syllables(&alpha).max(1);
        }
    }

    let mut sentences = 0usize;
    let mut long_sentences = 0usize;
    let mut sentence_lengths: Vec<usize> = Vec::new();
    for part in text.split(['.', '!', '?']) {
        let count = part
            .split_whitespace()
            .filter(|w| w.chars().any(|c| c.is_alphanumeric()))
            .count();
        if count > 0 {
            sentences += 1;
            sentence_lengths.push(count);
            if count >= 25 {
                long_sentences += 1;
            }
        }
    }
    if words > 0 && sentences == 0 {
        sentences = 1;
        sentence_lengths.push(words);
    }

    let avg_words_per_sentence = if sentences > 0 {
        ((words as f64 / sentences as f64) * 10.0).round() / 10.0
    } else {
        0.0
    };
    let reading_time_sec = if words > 0 {
        (((words as f64 / 200.0) * 60.0).round() as usize).max(1)
    } else {
        0
    };
    let speaking_time_sec = if words > 0 {
        (((words as f64 / 130.0) * 60.0).round() as usize).max(1)
    } else {
        0
    };

    let (flesch_reading_ease, flesch_kincaid_grade) = if words > 0 && sentences > 0 {
        let w_per_s = words as f64 / sentences as f64;
        let s_per_w = syllables as f64 / words as f64;
        let ease = (206.835 - 1.015 * w_per_s - 84.6 * s_per_w).clamp(0.0, 100.0);
        let grade = (0.39 * w_per_s + 11.8 * s_per_w - 15.59).max(0.0);
        ((ease * 10.0).round() / 10.0, (grade * 10.0).round() / 10.0)
    } else {
        (0.0, 0.0)
    };

    let passive_voice_count =
        regex::Regex::new(r"(?i)\b(?:am|is|are|was|were|be|been|being)\s+[a-z]{3,}(?:ed|en)\b")
            .map(|re| re.find_iter(text).count())
            .unwrap_or(0);

    let hedging_count = regex::Regex::new(
        r"(?i)\b(?:just|actually|basically|honestly|somewhat|arguably|perhaps|maybe|seemingly|kind of|sort of|i think|i feel)\b",
    )
    .map(|re| re.find_iter(text).count())
    .unwrap_or(0);

    let hedging_percent = if words > 0 {
        (((hedging_count as f64 / words as f64) * 100.0) * 10.0).round() / 10.0
    } else {
        0.0
    };

    let sentence_variety_score = if sentence_lengths.len() <= 1 {
        if words > 0 { 100 } else { 0 }
    } else {
        let mean = sentence_lengths.iter().sum::<usize>() as f64 / sentence_lengths.len() as f64;
        let variance = sentence_lengths
            .iter()
            .map(|&len| {
                let d = len as f64 - mean;
                d * d
            })
            .sum::<f64>()
            / sentence_lengths.len() as f64;
        let std_dev = variance.sqrt();
        // A standard deviation around 6+ words gives crisp human rhythm variety.
        ((std_dev / 6.0).min(1.0) * 100.0).round() as usize
    };

    ReadabilityReport {
        chars,
        words,
        sentences,
        syllables,
        long_sentences,
        avg_words_per_sentence,
        reading_time_sec,
        speaking_time_sec,
        flesch_reading_ease,
        flesch_kincaid_grade,
        passive_voice_count,
        hedging_count,
        hedging_percent,
        sentence_variety_score,
    }
}

fn count_syllables(word: &str) -> usize {
    if word.is_empty() {
        return 0;
    }
    if word.len() <= 3 {
        return 1;
    }
    let bytes = word.as_bytes();
    let is_vowel = |b: u8| matches!(b, b'a' | b'e' | b'i' | b'o' | b'u' | b'y');
    let mut count = 0usize;
    let mut prev_vowel = false;
    for &b in bytes {
        let v = is_vowel(b);
        if v && !prev_vowel {
            count += 1;
        }
        prev_vowel = v;
    }
    if word.ends_with('e') && !word.ends_with("le") && count > 1 {
        count -= 1;
    }
    count.max(1)
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

fn summarize_weirpack(pack: &Weirpack) -> Result<WeirpackValidationSummary, CoreError> {
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

/// Parse and run embedded Weir unit tests inside a `.weirpack` archive.
pub fn validate_weirpack_bytes(bytes: &[u8]) -> Result<WeirpackValidationSummary, CoreError> {
    let pack =
        Weirpack::from_bytes(bytes).map_err(|err| CoreError::InvalidLintConfig(err.to_string()))?;
    summarize_weirpack(&pack)
}

/// Build the canonical `lexel-antislop` Harper Weirpack with verified Weir rules.
pub fn build_antislop_weirpack() -> Result<Weirpack, CoreError> {
    let mut manifest = WeirpackManifest::new();
    manifest.set_author("Lexel");
    manifest.set_version("0.1.0");
    manifest.set_description("Lexel deterministic anti-slop rules for plain, direct human prose.");
    manifest.set_license("Apache-2.0");

    let mut pack = Weirpack::new(manifest);
    let rules: &[(&str, &str)] = &[
        (
            "LexelDelveInto",
            "expr main (delve into)\nlet message \"Use `explore` instead of AI filler `delve into`.\"\nlet description \"Replaces `delve into` with direct plain English.\"\nlet kind \"Style\"\nlet becomes \"explore\"\nlet strategy \"MatchCase\"\ntest \"We should delve into the root cause.\" \"We should explore the root cause.\"",
        ),
        (
            "LexelUtilize",
            "expr main utilize\nlet message \"Prefer `use` instead of `utilize`.\"\nlet description \"Simplifies bloated corporate phrasing.\"\nlet kind \"Style\"\nlet becomes \"use\"\nlet strategy \"MatchCase\"\ntest \"We utilize local SQLite storage.\" \"We use local SQLite storage.\"",
        ),
        (
            "LexelLeverage",
            "expr main leverage\nlet message \"Prefer `use` instead of buzzword `leverage`.\"\nlet description \"Replaces generic business jargon with direct phrasing.\"\nlet kind \"Style\"\nlet becomes \"use\"\nlet strategy \"MatchCase\"\ntest \"Teams leverage Rust for latency.\" \"Teams use Rust for latency.\"",
        ),
        (
            "LexelSeamlessly",
            "expr main seamlessly\nlet message \"Prefer `smoothly` or drop `seamlessly`.\"\nlet description \"Removes common AI marketing adverb.\"\nlet kind \"Style\"\nlet becomes \"smoothly\"\nlet strategy \"MatchCase\"\ntest \"The build runs seamlessly offline.\" \"The build runs smoothly offline.\"",
        ),
        (
            "LexelSeamless",
            "expr main seamless\nlet message \"Prefer `smooth` or `direct` instead of `seamless`.\"\nlet description \"Removes overused AI adjective.\"\nlet kind \"Style\"\nlet becomes \"smooth\"\nlet strategy \"MatchCase\"\ntest \"Enjoy a seamless local workflow.\" \"Enjoy a smooth local workflow.\"",
        ),
        (
            "LexelInOrderTo",
            "expr main (in order to)\nlet message \"Tighten `in order to` to `to`.\"\nlet description \"Eliminates filler prepositional padding.\"\nlet kind \"Redundancy\"\nlet becomes \"to\"\nlet strategy \"MatchCase\"\ntest \"Run tests in order to verify parity.\" \"Run tests to verify parity.\"",
        ),
        (
            "LexelTapestryOf",
            "expr main (a tapestry of)\nlet message \"Replace AI cliché `a tapestry of` with `a mix of`.\"\nlet description \"Flags cliché metaphor common in LLM outputs.\"\nlet kind \"Style\"\nlet becomes \"a mix of\"\nlet strategy \"MatchCase\"\ntest \"It offers a tapestry of options.\" \"It offers a mix of options.\"",
        ),
        (
            "LexelParamount",
            "expr main paramount\nlet message \"Prefer `essential` instead of `paramount`.\"\nlet description \"Replaces elevated AI filler with plain phrasing.\"\nlet kind \"Style\"\nlet becomes \"essential\"\nlet strategy \"MatchCase\"\ntest \"Low latency is paramount here.\" \"Low latency is essential here.\"",
        ),
        (
            "LexelGameChanger",
            "expr main game-changer\nlet message \"Replace hype phrase `game-changer` with `breakthrough`.\"\nlet description \"Removes marketing hype term.\"\nlet kind \"Style\"\nlet becomes \"breakthrough\"\nlet strategy \"MatchCase\"\ntest \"This parser is a game-changer for speed.\" \"This parser is a breakthrough for speed.\"",
        ),
        (
            "LexelElevate",
            "expr main elevate\nlet message \"Prefer `improve` instead of `elevate`.\"\nlet description \"Replaces generic corporate/AI verb.\"\nlet kind \"Style\"\nlet becomes \"improve\"\nlet strategy \"MatchCase\"\ntest \"Clear examples elevate the docs.\" \"Clear examples improve the docs.\"",
        ),
    ];

    for (name, rule) in rules {
        pack.add_rule(*name, *rule);
    }

    let summary = summarize_weirpack(&pack)?;
    if !summary.failures.is_empty() {
        return Err(CoreError::InvalidLintConfig(format!(
            "Built-in anti-slop Weirpack failed tests: {:?}",
            summary.failures
        )));
    }
    Ok(pack)
}

/// Serialize the verified `lexel-antislop` Weirpack to `.weirpack` ZIP bytes.
pub fn build_antislop_weirpack_bytes() -> Result<Vec<u8>, CoreError> {
    build_antislop_weirpack()?
        .to_bytes()
        .map_err(|err| CoreError::InvalidLintConfig(err.to_string()))
}

/// Encode `.weirpack` ZIP bytes as standard base64 for cross-surface sync.
pub fn encode_weirpack_base64(bytes: &[u8]) -> String {
    BASE64_STANDARD.encode(bytes)
}

/// Decode base64-encoded `.weirpack` bytes.
pub fn decode_weirpack_base64(encoded: &str) -> Result<Vec<u8>, CoreError> {
    BASE64_STANDARD
        .decode(encoded.trim())
        .map_err(|err| CoreError::InvalidLintConfig(format!("invalid base64 weirpack: {err}")))
}

/// Build and test-verify a single-rule custom `.weirpack` archive from Desktop or CLI inputs.
pub fn build_custom_weirpack_bytes(
    rule_name: &str,
    expr: &str,
    replacement: &str,
    message: Option<&str>,
    test_bad: Option<&str>,
    test_good: Option<&str>,
) -> Result<(String, Vec<u8>, WeirpackValidationSummary), CoreError> {
    let clean_name: String = rule_name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    let clean_name = if clean_name.is_empty() {
        "CustomLexelRule".to_owned()
    } else {
        clean_name
    };

    let raw_expr = expr.trim();
    let raw_replacement = replacement.trim();
    if raw_expr.is_empty() || raw_replacement.is_empty() {
        return Err(CoreError::InvalidLintConfig(
            "Both a target phrase and a replacement are required.".to_owned(),
        ));
    }

    let expr_clause = if raw_expr.contains(' ') && !raw_expr.starts_with('(') {
        format!("({raw_expr})")
    } else {
        raw_expr.to_owned()
    };
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let msg = message
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("Prefer {raw_replacement}."));

    let mut lines = vec![
        format!("expr main {expr_clause}"),
        format!("let message \"{}\"", esc(&msg)),
        "let description \"Custom Lexel Weir rule\"".to_owned(),
        "let kind \"Style\"".to_owned(),
        format!("let becomes \"{}\"", esc(raw_replacement)),
        "let strategy \"MatchCase\"".to_owned(),
    ];

    if let (Some(bad), Some(good)) = (test_bad, test_good) {
        let bad = bad.trim();
        let good = good.trim();
        if !bad.is_empty() && !good.is_empty() {
            lines.push(format!("test \"{}\" \"{}\"", esc(bad), esc(good)));
        }
    }

    let mut manifest = WeirpackManifest::new();
    manifest.set_author("Lexel User");
    manifest.set_version("0.1.0");
    manifest.set_description(format!("Custom rule for {raw_expr}"));
    manifest.set_license("Apache-2.0");

    let mut pack = Weirpack::new(manifest);
    pack.add_rule(&clean_name, lines.join("\n"));

    let summary = summarize_weirpack(&pack)?;
    if !summary.failures.is_empty() {
        return Err(CoreError::InvalidLintConfig(format!(
            "Weirpack test failed ({:?})",
            summary.failures
        )));
    }
    let bytes = pack
        .to_bytes()
        .map_err(|err| CoreError::InvalidLintConfig(err.to_string()))?;
    Ok((format!("{clean_name}.weirpack"), bytes, summary))
}
