mod bench;
mod doctor;

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result, bail};
use clap::{Args, Parser, Subcommand, ValueEnum};
use lexel_core::{
    HarperDiagnostic, HarperEngine, ReadabilityReport, RepoConfig, RulePreset, SlopScanner,
    StyleGuideRule, SurfaceCatalog, UnifiedSettings, analyze_readability,
    apply_safe_deterministic_fixes, apply_style_guide_fixes, build_antislop_weirpack_bytes,
    detect_language_from_path, normalize_typography, preset_rule_overrides, scan_invisible_chars,
    scan_secrets, scan_structure_issues, scan_style_guide, synonyms_for, to_sentence_case,
    to_title_case, validate_weirpack_bytes,
};
use lexel_db::{LexelDb, default_db_path};
use serde::Serialize;

#[derive(Parser)]
#[command(
    name = "lexel",
    version,
    about = "Lexel local zero-AI writing linter, CI gate, doctor, bench, and voice toolkit"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Lint files or stdin with deterministic Harper, anti-slop, surface, .lexel.toml, and secret rules
    Check(CheckArgs),
    /// Print offline readability, slop, and secret counts without altering text
    Stats(StatsArgs),
    /// Look up frequency-sorted English synonyms via harper-thesaurus
    Synonyms {
        word: String,
        #[arg(long)]
        json: bool,
    },
    /// Convert text (file, inline arg, or stdin) to Chicago title case
    TitleCase(TransformArgs),
    /// Convert text (file, inline arg, or stdin) to sentence case
    SentenceCase(TransformArgs),
    /// Normalize smart quotes, ellipses, and redundant spaces outside code blocks
    Normalize(TransformArgs),
    /// Validate or build Harper .weirpack archives
    Weirpack {
        #[command(subcommand)]
        action: WeirpackAction,
    },
    /// Install fast zero-AI Git commit-msg and/or pre-commit hooks for this repository
    InstallGitHook(InstallGitHookArgs),
    /// Check local Lexel runtime, acceleration, Native Messaging manifests, GGUF SHA-256, and speeds
    Doctor(doctor::DoctorArgs),
    /// Benchmark a running local daemon/model against held-out JSONL evaluation prompts
    Bench(bench::BenchArgs),
    /// Local SQLite database tools (SimPO preference export, weekly insights, crutch-word bans)
    Db {
        #[command(subcommand)]
        action: DbAction,
    },
    /// Clone My Voice cold-start import and local style fingerprint tools
    Voice {
        #[command(subcommand)]
        action: VoiceAction,
    },
}

#[derive(Clone, Copy, ValueEnum)]
enum OutputFormat {
    Text,
    Json,
    Sarif,
}

#[derive(Clone, Copy, ValueEnum, PartialEq, Eq)]
enum FailOn {
    None,
    Secrets,
    Slop,
    Any,
}

#[derive(Args)]
struct CheckArgs {
    /// Input files (reads stdin if omitted or "-")
    inputs: Vec<PathBuf>,
    #[arg(long)]
    surface: Option<String>,
    #[arg(long, default_value = "us")]
    dialect: String,
    #[arg(long)]
    language: Option<String>,
    #[arg(long, default_value = "curated")]
    preset: String,
    #[arg(long = "weirpack")]
    weirpacks: Vec<PathBuf>,
    /// Optional JSON file containing team style guide rules (`[{ term, preferred, caseSensitive?, note? }]`)
    #[arg(long = "style-guide")]
    style_guide: Option<PathBuf>,
    /// Optional explicit path to a .lexel.toml repo config file
    #[arg(long)]
    config: Option<PathBuf>,
    /// Disable automatic upward .lexel.toml discovery
    #[arg(long)]
    no_repo_config: bool,
    /// CI mode: enforce non-zero exit code on secrets, AI slop, or .lexel.toml violations (defaults --fail-on to slop)
    #[arg(long)]
    ci: bool,
    /// Apply deterministic anti-slop, em-dash, and surface cleanup
    #[arg(long)]
    fix_safe: bool,
    /// Apply safe slop cleanup, single-suggestion Harper fixes, and typography normalization
    #[arg(long)]
    fix_all: bool,
    /// Write fixed output back to input files (or stdout when reading stdin)
    #[arg(long)]
    write: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
    #[arg(long, value_enum, default_value_t = FailOn::None)]
    fail_on: FailOn,
}

#[derive(Args)]
struct StatsArgs {
    /// Optional file path (reads stdin when omitted or "-")
    input: Option<PathBuf>,
    #[arg(long, default_value = "general")]
    surface: String,
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct TransformArgs {
    /// Input file path (pass "-" or omit to read stdin; pass --text for inline text)
    input: Option<PathBuf>,
    #[arg(long)]
    text: Option<String>,
    /// Write transformed text back to the input file
    #[arg(long)]
    write: bool,
}

#[derive(Clone, Copy, ValueEnum)]
enum HookTarget {
    CommitMsg,
    PreCommit,
    Both,
}

#[derive(Args)]
struct InstallGitHookArgs {
    /// Target Git repository root (defaults to current working directory)
    #[arg(long, default_value = ".")]
    repo: PathBuf,
    /// Which Git hook(s) to install
    #[arg(long, value_enum, default_value_t = HookTarget::CommitMsg)]
    hook: HookTarget,
    /// Failure policy passed to `lexel check --fail-on`
    #[arg(long, value_enum, default_value_t = FailOn::Slop)]
    fail_on: FailOn,
    /// Overwrite an existing non-Lexel Git hook
    #[arg(long)]
    force: bool,
}

#[derive(Subcommand)]
enum WeirpackAction {
    /// Validate a .weirpack file and run all embedded Weir unit tests
    Validate {
        path: PathBuf,
        #[arg(long)]
        json: bool,
    },
    /// Generate Lexel's verified anti-slop .weirpack archive
    BuildAntislop { out: PathBuf },
}

#[derive(Subcommand)]
enum DbAction {
    /// Export edited/rejected voice examples as PII-scrubbed SimPO/DPO JSONL preference pairs
    ExportSimpo {
        /// Optional path to SQLite DB (defaults to platform lexel.db)
        #[arg(long)]
        db: Option<PathBuf>,
        /// Output JSONL file path (writes to stdout if omitted)
        #[arg(long)]
        out: Option<PathBuf>,
        /// Filter by surface_id
        #[arg(long)]
        surface: Option<String>,
        /// Also include accepted/imported examples where original != rewritten
        #[arg(long)]
        include_accepted: bool,
        /// Maximum rows to inspect
        #[arg(long, default_value_t = 500)]
        limit: usize,
    },
    /// Print Private Weekly Writing Insights computed strictly from local SQLite
    Insights {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long, default_value_t = 7)]
        days: usize,
        #[arg(long)]
        json: bool,
    },
    /// Manage personal crutch-word bans stored in local SQLite
    CrutchWords {
        #[command(subcommand)]
        op: CrutchWordOp,
    },
}

#[derive(Subcommand)]
enum CrutchWordOp {
    List {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        json: bool,
    },
    Ban {
        word: String,
        #[arg(long)]
        db: Option<PathBuf>,
    },
    Unban {
        word: String,
        #[arg(long)]
        db: Option<PathBuf>,
    },
}

#[derive(Subcommand)]
enum VoiceAction {
    /// Seed local voice memory and style fingerprint from Git commits or prose files
    Import(VoiceImportArgs),
    /// Show stylistic fingerprint statistics from stored voice examples
    Stats {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        surface: Option<String>,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Args)]
struct VoiceImportArgs {
    /// Import non-merge commit messages from a local Git repository
    #[arg(long)]
    git_log: bool,
    /// Optional author filter passed to `git log --author=...`
    #[arg(long)]
    author: Option<String>,
    /// Target Git repository path (defaults to current directory)
    #[arg(long, default_value = ".")]
    repo: PathBuf,
    /// Maximum Git commits to scan
    #[arg(long, default_value_t = 100)]
    limit: usize,
    /// Import prose paragraphs from one or more local markdown/text files
    #[arg(long, num_args = 1..)]
    files: Vec<PathBuf>,
    /// Target surface_id for file imports (`auto` infers docs_markdown vs general)
    #[arg(long, default_value = "auto")]
    surface: String,
    /// Optional path to SQLite DB (defaults to platform lexel.db)
    #[arg(long)]
    db: Option<PathBuf>,
    /// Emit JSON report
    #[arg(long)]
    json: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Finding {
    source: String,
    rule: String,
    severity: String,
    message: String,
    line: usize,
    column: usize,
    suggestion: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileCheckReport {
    path: String,
    language: String,
    surface: String,
    repo_config: Option<String>,
    fixed_applied: usize,
    findings: Vec<Finding>,
    readability: ReadabilityReport,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatsPayload {
    surface: String,
    readability: ReadabilityReport,
    slop_count: usize,
    surface_warning_count: usize,
    secret_count: usize,
}

fn parse_dialect(raw: &str) -> Result<u8> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "us" | "american" | "en-us" | "0" => Ok(0),
        "uk" | "british" | "en-gb" | "1" => Ok(1),
        "au" | "australian" | "en-au" | "2" => Ok(2),
        "ca" | "canadian" | "en-ca" | "3" => Ok(3),
        "in" | "indian" | "en-in" | "4" => Ok(4),
        other => bail!("Unsupported dialect '{other}'. Expected us, uk, au, ca, or in."),
    }
}

fn read_input_text(path: Option<&Path>, inline_text: Option<&str>) -> Result<(String, String)> {
    if let Some(txt) = inline_text {
        return Ok(("<inline>".to_owned(), txt.to_owned()));
    }
    match path {
        Some(p) if p != Path::new("-") => {
            let content =
                fs::read_to_string(p).with_context(|| format!("Failed to read {}", p.display()))?;
            Ok((p.display().to_string(), content))
        }
        _ => {
            let mut buf = String::new();
            io::stdin()
                .read_to_string(&mut buf)
                .context("Failed to read stdin")?;
            Ok(("<stdin>".to_owned(), buf))
        }
    }
}

fn byte_offset_to_line_col(text: &str, byte_offset: usize) -> (usize, usize) {
    let clamped = byte_offset.min(text.len());
    let prefix = &text[..clamped];
    let line = prefix.bytes().filter(|&b| b == b'\n').count() + 1;
    let col = match prefix.rfind('\n') {
        Some(pos) => prefix[pos + 1..].chars().count() + 1,
        None => prefix.chars().count() + 1,
    };
    (line, col)
}

fn char_offset_to_line_col(text: &str, char_offset: usize) -> (usize, usize) {
    let mut line = 1usize;
    let mut col = 1usize;
    for (i, ch) in text.chars().enumerate() {
        if i >= char_offset {
            break;
        }
        if ch == '\n' {
            line += 1;
            col = 1;
        } else {
            col += 1;
        }
    }
    (line, col)
}

struct CheckBase {
    dialect_code: u8,
    base_overrides: BTreeMap<String, Option<bool>>,
    weirpack_bytes: Vec<Vec<u8>>,
    scanner: SlopScanner,
    catalog: SurfaceCatalog,
    cli_style_guide: Vec<StyleGuideRule>,
    explicit_repo_config: Option<(PathBuf, RepoConfig)>,
}

struct CheckInput<'a> {
    path_label: &'a str,
    text: String,
    language: &'a str,
    surface_id: &'a str,
    real_path: Option<&'a Path>,
}

fn resolve_repo_config(
    base: &CheckBase,
    real_path: Option<&Path>,
    no_repo_config: bool,
) -> Option<(PathBuf, RepoConfig)> {
    if no_repo_config {
        return None;
    }
    if let Some(ref explicit) = base.explicit_repo_config {
        return Some(explicit.clone());
    }
    if let Some(p) = real_path {
        return RepoConfig::discover(p);
    }
    std::env::current_dir()
        .ok()
        .and_then(|cwd| RepoConfig::discover(&cwd))
}

fn run_check_on_text(
    base: &CheckBase,
    input: CheckInput<'_>,
    args: &CheckArgs,
) -> Result<FileCheckReport> {
    let mut text = input.text;
    let language = input.language;
    let surface_id = input.surface_id;
    let mut total_fixed = 0usize;

    let discovered_cfg = resolve_repo_config(base, input.real_path, args.no_repo_config);
    let mut effective_settings = UnifiedSettings {
        dialect: base.dialect_code,
        lint_config: base.base_overrides.clone(),
        style_guide: base.cli_style_guide.clone(),
        ..UnifiedSettings::default()
    };
    if let Some((_, ref cfg)) = discovered_cfg {
        cfg.apply_to_settings(&mut effective_settings);
    }

    let mut engine = HarperEngine::new(
        effective_settings.dialect,
        &effective_settings.lint_config,
        &effective_settings.user_dictionary,
        "",
    )?;
    for bytes in &base.weirpack_bytes {
        engine.add_weirpack_bytes(bytes)?;
    }

    if args.fix_safe || args.fix_all {
        let safe = apply_safe_deterministic_fixes(
            &text,
            surface_id,
            &effective_settings.custom_slop_terms,
            &effective_settings.disabled_slop_terms,
            &[],
        )?;
        total_fixed += safe.fixes_applied;
        text = safe.text;
        let styled = apply_style_guide_fixes(&text, &effective_settings.style_guide);
        total_fixed += styled.fixes_applied;
        text = styled.text;
    }
    if args.fix_all {
        let harper_safe = engine.apply_safe_harper_fixes(&text, language);
        total_fixed += harper_safe.fixes_applied;
        text = harper_safe.text;

        let normalized = normalize_typography(&text);
        total_fixed += normalized.fixes_applied;
        text = normalized.text;
    }

    if args.write && (args.fix_safe || args.fix_all) {
        if let Some(p) = input.real_path {
            if total_fixed > 0 {
                fs::write(p, &text)
                    .with_context(|| format!("Failed to write fixed output to {}", p.display()))?;
            }
        } else {
            print!("{text}");
        }
    }

    let profile = base.catalog.get(surface_id)?;
    let allow_em_dashes = discovered_cfg
        .as_ref()
        .map(|(_, cfg)| cfg.effective_allow_em_dashes(surface_id, profile.allow_em_dashes))
        .unwrap_or(profile.allow_em_dashes);

    let mut findings = Vec::new();

    for diag in engine.check_text_with_language(&text, language) {
        findings.push(harper_diag_to_finding(&text, diag));
    }

    for hit in base.scanner.scan_with_overrides(
        &text,
        allow_em_dashes,
        &effective_settings.custom_slop_terms,
        &effective_settings.disabled_slop_terms,
    ) {
        let (line, column) = byte_offset_to_line_col(&text, hit.start);
        findings.push(Finding {
            source: "LexelAntiSlop".to_owned(),
            rule: if hit.is_em_dash {
                "em_dash".to_owned()
            } else {
                format!("slop:{}", hit.term)
            },
            severity: "warning".to_owned(),
            message: if hit.is_em_dash {
                "Em dash detected; replace with comma, period, or parentheses.".to_owned()
            } else if let Some(ref s) = hit.suggestion {
                if s.is_empty() {
                    format!("AI filler phrase \"{}\"; remove it cleanly.", hit.term)
                } else {
                    format!("AI buzzword \"{}\"; prefer \"{}\".", hit.term, s)
                }
            } else {
                format!("AI buzzword \"{}\".", hit.term)
            },
            line,
            column,
            suggestion: hit.suggestion,
        });
    }

    for v in base.catalog.validate(&text, surface_id)? {
        let (line, column) = byte_offset_to_line_col(&text, v.start);
        findings.push(Finding {
            source: "LexelSurface".to_owned(),
            rule: v.kind,
            severity: "warning".to_owned(),
            message: v.message,
            line,
            column,
            suggestion: None,
        });
    }

    if let Some((_, ref cfg)) = discovered_cfg {
        for v in cfg.validate_text(&text, surface_id) {
            let (line, column) = byte_offset_to_line_col(&text, v.start);
            findings.push(Finding {
                source: "LexelRepoConfig".to_owned(),
                rule: v.kind,
                severity: "warning".to_owned(),
                message: v.message,
                line,
                column,
                suggestion: None,
            });
        }
    }

    for secret in scan_secrets(&text) {
        let (line, column) = byte_offset_to_line_col(&text, secret.start);
        findings.push(Finding {
            source: "LexelSecrets".to_owned(),
            rule: secret.kind,
            severity: "error".to_owned(),
            message: format!(
                "Detected {} ({}). Redact before sharing.",
                secret.label, secret.masked_preview
            ),
            line,
            column,
            suggestion: Some("[REDACTED]".to_owned()),
        });
    }

    for inv in scan_invisible_chars(&text) {
        let (line, column) = byte_offset_to_line_col(&text, inv.start);
        findings.push(Finding {
            source: "LexelInvisibleChars".to_owned(),
            rule: inv.codepoint.clone(),
            severity: "warning".to_owned(),
            message: format!(
                "Hidden Unicode character {} ({}).",
                inv.label, inv.codepoint
            ),
            line,
            column,
            suggestion: Some(inv.replacement),
        });
    }

    for issue in scan_structure_issues(&text) {
        let (line, column) = byte_offset_to_line_col(&text, issue.start);
        findings.push(Finding {
            source: "LexelStructure".to_owned(),
            rule: issue.kind,
            severity: "warning".to_owned(),
            message: issue.message,
            line,
            column,
            suggestion: issue.suggestion,
        });
    }

    for hit in scan_style_guide(&text, &effective_settings.style_guide) {
        let (line, column) = byte_offset_to_line_col(&text, hit.start);
        let note = hit
            .note
            .as_deref()
            .map(|n| format!(" ({n})"))
            .unwrap_or_default();
        findings.push(Finding {
            source: "LexelStyleGuide".to_owned(),
            rule: format!("style:{}", hit.term),
            severity: "warning".to_owned(),
            message: format!(
                "Style guide prefers \"{}\" over \"{}\"{note}.",
                hit.preferred, hit.term
            ),
            line,
            column,
            suggestion: Some(hit.preferred),
        });
    }

    findings.sort_by_key(|f| (f.line, f.column));

    Ok(FileCheckReport {
        path: input.path_label.to_owned(),
        language: language.to_owned(),
        surface: surface_id.to_owned(),
        repo_config: discovered_cfg.map(|(p, _)| p.display().to_string()),
        fixed_applied: total_fixed,
        readability: analyze_readability(&text),
        findings,
    })
}

fn harper_diag_to_finding(text: &str, diag: HarperDiagnostic) -> Finding {
    let (line, column) = char_offset_to_line_col(text, diag.start);
    Finding {
        source: "Harper".to_owned(),
        rule: diag.rule,
        severity: match diag.lint_kind.as_str() {
            "Spelling" | "Typo" | "Grammar" | "Agreement" => "warning".to_owned(),
            _ => "note".to_owned(),
        },
        message: diag.message,
        line,
        column,
        suggestion: diag.suggestions.into_iter().next(),
    }
}

fn build_sarif(reports: &[FileCheckReport]) -> serde_json::Value {
    let mut results = Vec::new();
    let mut rule_map: BTreeMap<String, serde_json::Value> = BTreeMap::new();

    for report in reports {
        for f in &report.findings {
            let rule_id = format!("{}/{}", f.source, f.rule);
            rule_map.entry(rule_id.clone()).or_insert_with(|| {
                serde_json::json!({
                    "id": rule_id,
                    "shortDescription": { "text": format!("{} rule {}", f.source, f.rule) },
                    "defaultConfiguration": { "level": f.severity }
                })
            });
            results.push(serde_json::json!({
                "ruleId": rule_id,
                "level": f.severity,
                "message": { "text": f.message },
                "locations": [{
                    "physicalLocation": {
                        "artifactLocation": { "uri": report.path },
                        "region": {
                            "startLine": f.line,
                            "startColumn": f.column
                        }
                    }
                }]
            }));
        }
    }
    let rules: Vec<serde_json::Value> = rule_map.into_values().collect();
    serde_json::json!({
        "$schema": "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
        "version": "2.1.0",
        "runs": [{
            "tool": {
                "driver": {
                    "name": "Lexel",
                    "version": env!("CARGO_PKG_VERSION"),
                    "informationUri": "https://github.com/Lexel-Ai/Lexel",
                    "rules": rules
                }
            },
            "results": results
        }]
    })
}

fn cmd_check(args: CheckArgs) -> Result<ExitCode> {
    let dialect_code = parse_dialect(&args.dialect)?;
    let preset = RulePreset::parse(&args.preset).with_context(|| {
        format!(
            "Unknown preset '{}'. Expected curated, strict_technical, formal_academic, or casual_chat.",
            args.preset
        )
    })?;
    let base_overrides: BTreeMap<String, Option<bool>> = preset_rule_overrides(preset);
    let mut weirpack_bytes = Vec::new();
    for wp in &args.weirpacks {
        let bytes =
            fs::read(wp).with_context(|| format!("Failed to read weirpack {}", wp.display()))?;
        weirpack_bytes.push(bytes);
    }

    let cli_style_guide: Vec<StyleGuideRule> = match &args.style_guide {
        Some(path) => {
            let raw = fs::read_to_string(path)
                .with_context(|| format!("Failed to read style guide {}", path.display()))?;
            serde_json::from_str(&raw)
                .with_context(|| format!("Invalid style guide JSON in {}", path.display()))?
        }
        None => Vec::new(),
    };

    let explicit_repo_config = match &args.config {
        Some(path) => {
            let cfg = RepoConfig::load_from_path(path).map_err(anyhow::Error::msg)?;
            Some((path.clone(), cfg))
        }
        None => None,
    };

    let scanner = SlopScanner::load_embedded()?;
    let catalog = SurfaceCatalog::load_embedded()?;
    let base = CheckBase {
        dialect_code,
        base_overrides,
        weirpack_bytes,
        scanner,
        catalog,
        cli_style_guide,
        explicit_repo_config,
    };

    let mut reports = Vec::new();
    if args.inputs.is_empty() || (args.inputs.len() == 1 && args.inputs[0] == Path::new("-")) {
        let (label, content) = read_input_text(None, None)?;
        let language = args
            .language
            .clone()
            .unwrap_or_else(|| "plaintext".to_owned());
        let surface = args.surface.clone().unwrap_or_else(|| {
            if language == "git-commit" {
                "ide_git_commit".to_owned()
            } else {
                "general".to_owned()
            }
        });
        reports.push(run_check_on_text(
            &base,
            CheckInput {
                path_label: &label,
                text: content,
                language: &language,
                surface_id: &surface,
                real_path: None,
            },
            &args,
        )?);
    } else {
        for path in &args.inputs {
            let (label, content) = read_input_text(Some(path), None)?;
            let language = args
                .language
                .clone()
                .unwrap_or_else(|| detect_language_from_path(path).to_owned());
            let surface = args.surface.clone().unwrap_or_else(|| {
                if language == "git-commit" {
                    "ide_git_commit".to_owned()
                } else if language == "markdown" || language == "asciidoc" || language == "tex" {
                    "docs_markdown".to_owned()
                } else {
                    "general".to_owned()
                }
            });
            let real_path = if path == Path::new("-") {
                None
            } else {
                Some(path.as_path())
            };
            reports.push(run_check_on_text(
                &base,
                CheckInput {
                    path_label: &label,
                    text: content,
                    language: &language,
                    surface_id: &surface,
                    real_path,
                },
                &args,
            )?);
        }
    }

    match args.format {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string_pretty(&reports)?);
        }
        OutputFormat::Sarif => {
            println!("{}", serde_json::to_string_pretty(&build_sarif(&reports))?);
        }
        OutputFormat::Text => {
            for r in &reports {
                if !(args.write && args.inputs.is_empty()) {
                    println!(
                        "{} (lang={}, surface={}, grade={:.1}, fixes={})",
                        r.path,
                        r.language,
                        r.surface,
                        r.readability.flesch_kincaid_grade,
                        r.fixed_applied
                    );
                }
                for f in &r.findings {
                    let hint = f
                        .suggestion
                        .as_deref()
                        .map(|s| format!(" -> {s}"))
                        .unwrap_or_default();
                    println!(
                        "  {}:{}: [{} {}] {}{}",
                        f.line, f.column, f.source, f.rule, f.message, hint
                    );
                }
            }
        }
    }

    let has_secrets = reports
        .iter()
        .any(|r| r.findings.iter().any(|f| f.source == "LexelSecrets"));
    let has_slop_or_repo = reports.iter().any(|r| {
        r.findings
            .iter()
            .any(|f| f.source == "LexelAntiSlop" || f.source == "LexelRepoConfig")
    });
    let has_any = reports.iter().any(|r| !r.findings.is_empty());

    let effective_fail_on = if args.ci && args.fail_on == FailOn::None {
        FailOn::Slop
    } else {
        args.fail_on
    };

    let should_fail = match effective_fail_on {
        FailOn::None => false,
        FailOn::Secrets => has_secrets,
        FailOn::Slop => has_slop_or_repo || has_secrets,
        FailOn::Any => has_any,
    };

    if args.ci {
        let total_findings: usize = reports.iter().map(|r| r.findings.len()).sum();
        eprintln!(
            "lexel ci: scanned {} file(s), {} finding(s), status={}",
            reports.len(),
            total_findings,
            if should_fail { "FAILED" } else { "PASS" }
        );
    }

    Ok(if should_fail {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    })
}

fn fail_on_flag(f: FailOn) -> &'static str {
    match f {
        FailOn::None => "none",
        FailOn::Secrets => "secrets",
        FailOn::Slop => "slop",
        FailOn::Any => "any",
    }
}

fn write_git_hook(path: &Path, body: &str, force: bool) -> Result<()> {
    if path.exists() && !force {
        let existing = fs::read_to_string(path).unwrap_or_default();
        if !existing.contains("# lexel-managed-hook") {
            bail!(
                "Hook {} already exists and is not managed by Lexel. Re-run with --force to replace it.",
                path.display()
            );
        }
    }
    fs::write(path, body).with_context(|| format!("Failed to write {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

fn cmd_install_git_hook(args: InstallGitHookArgs) -> Result<()> {
    let git_dir = args.repo.join(".git");
    if !git_dir.exists() {
        bail!(
            "No .git directory found at {}. Pass --repo <path> pointing to a Git repository.",
            args.repo.display()
        );
    }
    let hooks_dir = git_dir.join("hooks");
    fs::create_dir_all(&hooks_dir)?;

    let fail_arg = fail_on_flag(args.fail_on);
    let mut installed = Vec::new();

    if matches!(args.hook, HookTarget::CommitMsg | HookTarget::Both) {
        let path = hooks_dir.join("commit-msg");
        let script = format!(
            "#!/usr/bin/env sh\n# lexel-managed-hook\nset -e\nif command -v lexel >/dev/null 2>&1; then\n  lexel check --surface ide_git_commit --language git-commit --fail-on {fail_arg} \"$1\"\nfi\n"
        );
        write_git_hook(&path, &script, args.force)?;
        installed.push(path);
    }

    if matches!(args.hook, HookTarget::PreCommit | HookTarget::Both) {
        let path = hooks_dir.join("pre-commit");
        let script = "#!/usr/bin/env sh\n# lexel-managed-hook\nset -e\nif ! command -v lexel >/dev/null 2>&1; then\n  exit 0\nfi\nSTAGED=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\\.(md|mdx|txt|rst|adoc|tex|typ)$' || true)\nif [ -n \"$STAGED\" ]; then\n  echo \"$STAGED\" | xargs lexel check --fail-on secrets\nfi\n";
        write_git_hook(&path, script, args.force)?;
        installed.push(path);
    }

    for p in installed {
        println!("Installed Lexel Git hook at {}", p.display());
    }
    Ok(())
}

fn cmd_transform(args: TransformArgs, op: &str) -> Result<()> {
    let (_label, content) = read_input_text(args.input.as_deref(), args.text.as_deref())?;
    let transformed = match op {
        "title" => to_title_case(&content),
        "sentence" => to_sentence_case(&content),
        "normalize" => normalize_typography(&content).text,
        _ => unreachable!(),
    };
    if args.write
        && let Some(path) = args.input.as_deref()
        && path != Path::new("-")
    {
        fs::write(path, &transformed)
            .with_context(|| format!("Failed to write {}", path.display()))?;
    } else {
        print!("{transformed}");
    }
    Ok(())
}

fn open_db(db_override: Option<&Path>) -> Result<LexelDb> {
    let path = db_override
        .map(Path::to_path_buf)
        .unwrap_or_else(default_db_path);
    LexelDb::open(&path).with_context(|| format!("Failed to open Lexel DB at {}", path.display()))
}

fn cmd_db(action: DbAction) -> Result<()> {
    match action {
        DbAction::ExportSimpo {
            db,
            out,
            surface,
            include_accepted,
            limit,
        } => {
            let store = open_db(db.as_deref())?;
            let pairs = store.export_simpo_pairs(surface.as_deref(), include_accepted, limit)?;
            let mut jsonl = String::new();
            for pair in &pairs {
                jsonl.push_str(&serde_json::to_string(pair)?);
                jsonl.push('\n');
            }
            if let Some(ref out_path) = out {
                if let Some(parent) = out_path.parent()
                    && !parent.as_os_str().is_empty()
                {
                    fs::create_dir_all(parent)?;
                }
                fs::write(out_path, &jsonl)
                    .with_context(|| format!("Failed to write {}", out_path.display()))?;
                eprintln!(
                    "Exported {} PII-scrubbed SimPO preference pair(s) to {}",
                    pairs.len(),
                    out_path.display()
                );
            } else {
                print!("{jsonl}");
            }
        }
        DbAction::Insights { db, days, json } => {
            let store = open_db(db.as_deref())?;
            let report = store.weekly_insights(days)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                println!(
                    "Private Weekly Insights (last {} days, 100% local SQLite)",
                    report.period_days
                );
                println!(
                    "  Checks: {} | Words: {} | Slop caught: {} | Grammar hits: {} | Secrets blocked: {} | Fixes: {}",
                    report.checks_in_period,
                    report.words_in_period,
                    report.slop_caught_in_period,
                    report.grammar_hits_in_period,
                    report.secrets_blocked_in_period,
                    report.fixes_applied_in_period
                );
                println!(
                    "  Clarity: {}/100 ({:+}) | Conciseness: {}/100 ({:+}) | Voice examples: {}",
                    report.clarity_score,
                    report.clarity_delta,
                    report.conciseness_score,
                    report.conciseness_delta,
                    report.voice_examples_count
                );
                if !report.top_crutch_words.is_empty() {
                    let list: Vec<String> = report
                        .top_crutch_words
                        .iter()
                        .map(|c| {
                            if c.banned {
                                format!("{} ({}, banned)", c.word, c.count)
                            } else {
                                format!("{} ({})", c.word, c.count)
                            }
                        })
                        .collect();
                    println!("  Top crutch words: {}", list.join(", "));
                }
                if !report.top_slop_patterns.is_empty() {
                    let list: Vec<String> = report
                        .top_slop_patterns
                        .iter()
                        .map(|(t, n)| format!("{t} ({n})"))
                        .collect();
                    println!("  Slop patterns:    {}", list.join(", "));
                }
            }
        }
        DbAction::CrutchWords { op } => match op {
            CrutchWordOp::List { db, json } => {
                let store = open_db(db.as_deref())?;
                let words = store.list_crutch_word_bans()?;
                if json {
                    println!("{}", serde_json::to_string_pretty(&words)?);
                } else if words.is_empty() {
                    println!("No personal crutch words banned.");
                } else {
                    println!("{}", words.join(", "));
                }
            }
            CrutchWordOp::Ban { word, db } => {
                let store = open_db(db.as_deref())?;
                let updated = store.toggle_crutch_word_ban(&word, true)?;
                println!(
                    "Banned crutch word '{word}'. Active bans: {}",
                    updated.join(", ")
                );
            }
            CrutchWordOp::Unban { word, db } => {
                let store = open_db(db.as_deref())?;
                let updated = store.toggle_crutch_word_ban(&word, false)?;
                println!(
                    "Unbanned crutch word '{word}'. Active bans: {}",
                    if updated.is_empty() {
                        "(none)".to_owned()
                    } else {
                        updated.join(", ")
                    }
                );
            }
        },
    }
    Ok(())
}

fn cmd_voice(action: VoiceAction) -> Result<()> {
    match action {
        VoiceAction::Import(args) => {
            if !args.git_log && args.files.is_empty() {
                bail!("Pass either --git-log or --files <paths>... to import voice samples.");
            }
            let store = open_db(args.db.as_deref())?;
            let mut reports = Vec::new();
            if args.git_log {
                let rep = store.import_voice_from_git_log(
                    &args.repo,
                    args.author.as_deref(),
                    args.limit,
                )?;
                reports.push(rep);
            }
            if !args.files.is_empty() {
                let rep = store.import_voice_from_files(&args.files, &args.surface)?;
                reports.push(rep);
            }

            if args.json {
                if reports.len() == 1 {
                    println!("{}", serde_json::to_string_pretty(&reports[0])?);
                } else {
                    println!("{}", serde_json::to_string_pretty(&reports)?);
                }
            } else {
                for rep in reports {
                    println!(
                        "Imported {} voice example(s) from {} (skipped {}). Total stored: {} | Avg sentence: {:.1} words | Directness: {}/100 | Em-dash free: {:.0}%",
                        rep.imported_count,
                        rep.source_kind,
                        rep.skipped_count,
                        rep.style_stats.total_examples,
                        rep.style_stats.avg_sentence_words,
                        rep.style_stats.directness_score,
                        rep.style_stats.em_dash_free_rate * 100.0
                    );
                }
            }
        }
        VoiceAction::Stats { db, surface, json } => {
            let store = open_db(db.as_deref())?;
            let stats = store.voice_style_stats(surface.as_deref())?;
            if json {
                println!("{}", serde_json::to_string_pretty(&stats)?);
            } else {
                println!(
                    "Voice examples: {} | Avg sentence: {:.1} words | Avg word length: {:.1} | Directness: {}/100 | Em-dash free: {:.0}%",
                    stats.total_examples,
                    stats.avg_sentence_words,
                    stats.avg_word_length,
                    stats.directness_score,
                    stats.em_dash_free_rate * 100.0
                );
            }
        }
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<ExitCode> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Check(args) => return cmd_check(args),
        Commands::Stats(args) => {
            let (_label, content) = read_input_text(args.input.as_deref(), None)?;
            let readability = analyze_readability(&content);
            let scanner = SlopScanner::load_embedded()?;
            let catalog = SurfaceCatalog::load_embedded()?;
            let profile = catalog.get(&args.surface)?;
            let slop_count = scanner.scan(&content, profile.allow_em_dashes).len();
            let surface_warning_count = catalog.validate(&content, &args.surface)?.len();
            let secret_count = scan_secrets(&content).len();

            if args.json {
                let payload = StatsPayload {
                    surface: args.surface,
                    readability,
                    slop_count,
                    surface_warning_count,
                    secret_count,
                };
                println!("{}", serde_json::to_string_pretty(&payload)?);
            } else {
                println!(
                    "Words: {} | Sentences: {} | FK Grade: {:.1} | Ease: {:.1} | Read time: {}s | Long sentences: {} | Slop: {} | Surface: {} | Secrets: {}",
                    readability.words,
                    readability.sentences,
                    readability.flesch_kincaid_grade,
                    readability.flesch_reading_ease,
                    readability.reading_time_sec,
                    readability.long_sentences,
                    slop_count,
                    surface_warning_count,
                    secret_count
                );
            }
        }
        Commands::Synonyms { word, json } => {
            let list = synonyms_for(&word);
            if json {
                println!("{}", serde_json::to_string_pretty(&list)?);
            } else if list.is_empty() {
                println!("No synonyms found for '{word}'.");
            } else {
                println!("{}", list.join(", "));
            }
        }
        Commands::TitleCase(args) => cmd_transform(args, "title")?,
        Commands::SentenceCase(args) => cmd_transform(args, "sentence")?,
        Commands::Normalize(args) => cmd_transform(args, "normalize")?,
        Commands::Weirpack { action } => match action {
            WeirpackAction::Validate { path, json } => {
                let bytes = fs::read(&path)
                    .with_context(|| format!("Failed to read {}", path.display()))?;
                let summary = validate_weirpack_bytes(&bytes)?;
                if json {
                    println!("{}", serde_json::to_string_pretty(&summary)?);
                } else {
                    println!(
                        "Verified {} rules ({:?}), failures: {}",
                        summary.rule_count,
                        summary.rule_names,
                        summary.failures.len()
                    );
                }
                if !summary.failures.is_empty() {
                    return Ok(ExitCode::from(1));
                }
            }
            WeirpackAction::BuildAntislop { out } => {
                let bytes = build_antislop_weirpack_bytes()?;
                if let Some(parent) = out.parent()
                    && !parent.as_os_str().is_empty()
                {
                    fs::create_dir_all(parent)?;
                }
                fs::write(&out, &bytes)
                    .with_context(|| format!("Failed to write {}", out.display()))?;
                let summary = validate_weirpack_bytes(&bytes)?;
                println!(
                    "Wrote {} ({} bytes, {} verified rules)",
                    out.display(),
                    bytes.len(),
                    summary.rule_count
                );
            }
        },
        Commands::InstallGitHook(args) => cmd_install_git_hook(args)?,
        Commands::Doctor(args) => doctor::run_doctor(args).await?,
        Commands::Bench(args) => bench::run_bench(args).await?,
        Commands::Db { action } => cmd_db(action)?,
        Commands::Voice { action } => cmd_voice(action)?,
    }
    Ok(ExitCode::SUCCESS)
}
