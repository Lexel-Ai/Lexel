use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result, bail};
use clap::{Args, Parser, Subcommand, ValueEnum};
use lexel_core::{
    HarperDiagnostic, HarperEngine, ReadabilityReport, RulePreset, SlopScanner, SurfaceCatalog,
    analyze_readability, apply_safe_deterministic_fixes, build_antislop_weirpack_bytes,
    detect_language_from_path, normalize_typography, preset_rule_overrides, scan_secrets,
    synonyms_for, to_sentence_case, to_title_case, validate_weirpack_bytes,
};
use serde::Serialize;

#[derive(Parser)]
#[command(
    name = "lexel",
    version,
    about = "Lexel local zero-AI writing linter and toolkit"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Lint files or stdin with deterministic Harper, anti-slop, surface, and secret rules
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
}

#[derive(Clone, Copy, ValueEnum)]
enum OutputFormat {
    Text,
    Json,
    Sarif,
}

#[derive(Clone, Copy, ValueEnum)]
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

struct CheckContext {
    engine: HarperEngine,
    scanner: SlopScanner,
    catalog: SurfaceCatalog,
}

struct CheckInput<'a> {
    path_label: &'a str,
    text: String,
    language: &'a str,
    surface_id: &'a str,
    real_path: Option<&'a Path>,
}

fn run_check_on_text(
    ctx: &mut CheckContext,
    input: CheckInput<'_>,
    args: &CheckArgs,
) -> Result<FileCheckReport> {
    let mut text = input.text;
    let language = input.language;
    let surface_id = input.surface_id;
    let mut total_fixed = 0usize;

    if args.fix_safe || args.fix_all {
        let safe = apply_safe_deterministic_fixes(&text, surface_id, &[], &[], &[])?;
        total_fixed += safe.fixes_applied;
        text = safe.text;
    }
    if args.fix_all {
        let harper_safe = ctx.engine.apply_safe_harper_fixes(&text, language);
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

    let profile = ctx.catalog.get(surface_id)?;
    let mut findings = Vec::new();

    for diag in ctx.engine.check_text_with_language(&text, language) {
        findings.push(harper_diag_to_finding(&text, diag));
    }

    for hit in ctx.scanner.scan(&text, profile.allow_em_dashes) {
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

    for v in ctx.catalog.validate(&text, surface_id)? {
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

    findings.sort_by_key(|f| (f.line, f.column));

    Ok(FileCheckReport {
        path: input.path_label.to_owned(),
        language: language.to_owned(),
        surface: surface_id.to_owned(),
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
    for report in reports {
        for f in &report.findings {
            results.push(serde_json::json!({
                "ruleId": format!("{}/{}", f.source, f.rule),
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
    serde_json::json!({
        "$schema": "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
        "version": "2.1.0",
        "runs": [{
            "tool": {
                "driver": {
                    "name": "Lexel",
                    "version": env!("CARGO_PKG_VERSION")
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
    let overrides: BTreeMap<String, Option<bool>> = preset_rule_overrides(preset);
    let mut engine = HarperEngine::new(dialect_code, &overrides, &[], "")?;
    for wp in &args.weirpacks {
        let bytes =
            fs::read(wp).with_context(|| format!("Failed to read weirpack {}", wp.display()))?;
        engine.add_weirpack_bytes(&bytes)?;
    }

    let scanner = SlopScanner::load_embedded()?;
    let catalog = SurfaceCatalog::load_embedded()?;
    let mut ctx = CheckContext {
        engine,
        scanner,
        catalog,
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
            &mut ctx,
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
                &mut ctx,
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
    let has_slop = reports
        .iter()
        .any(|r| r.findings.iter().any(|f| f.source == "LexelAntiSlop"));
    let has_any = reports.iter().any(|r| !r.findings.is_empty());

    let should_fail = match args.fail_on {
        FailOn::None => false,
        FailOn::Secrets => has_secrets,
        FailOn::Slop => has_slop || has_secrets,
        FailOn::Any => has_any,
    };

    Ok(if should_fail {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    })
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

fn main() -> Result<ExitCode> {
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
    }
    Ok(ExitCode::SUCCESS)
}
