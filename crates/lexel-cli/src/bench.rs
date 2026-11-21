use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use clap::Args;
use lexel_core::{GateCheckSummary, verify_rewrite};
use lexel_db::default_token_path;
use serde::{Deserialize, Serialize};

#[derive(Args)]
pub struct BenchArgs {
    /// Path to held-out evaluation JSONL file
    #[arg(long, default_value = "ml/datasets/lexel_heldout_eval.jsonl")]
    pub eval: PathBuf,
    /// Running lexel-daemon HTTP base URL
    #[arg(long, default_value = "http://127.0.0.1:42424")]
    pub endpoint: String,
    /// Optional Bearer token (defaults to reading ~/.local/share/lexel/daemon.token)
    #[arg(long)]
    pub token: Option<String>,
    /// Optional max number of evaluation rows to run
    #[arg(long)]
    pub limit: Option<usize>,
    /// Optional filter to run only one surface_id
    #[arg(long)]
    pub surface: Option<String>,
    /// Optional path to write per-row JSONL results
    #[arg(long)]
    pub out: Option<PathBuf>,
    /// Emit machine-readable JSON summary
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EvalRow {
    #[serde(alias = "id")]
    pub eval_id: String,
    pub surface_id: String,
    pub task: String,
    #[serde(default)]
    pub subcontext: Option<String>,
    #[serde(default)]
    pub thread_context: Option<String>,
    pub source: String,
    #[serde(default)]
    pub reference_target: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchRowOutcome {
    pub eval_id: String,
    pub surface_id: String,
    pub task: String,
    pub ok: bool,
    pub error: Option<String>,
    pub model: Option<String>,
    pub fast_path: bool,
    pub retried: bool,
    pub latency_ms: u64,
    pub zero_slop: bool,
    pub numbers_preserved: bool,
    pub tokens_preserved: bool,
    pub surface_compliant: bool,
    pub grammar_clean: bool,
    pub secrets_free: bool,
    pub warnings: Vec<String>,
    pub suggestion: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference_target: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceBenchStats {
    pub total: usize,
    pub evaluated: usize,
    pub slop_rate_pct: f64,
    pub numbers_preserved_pct: f64,
    pub tokens_preserved_pct: f64,
    pub surface_pass_pct: f64,
    pub all_gates_pass_pct: f64,
    pub latency_p50_ms: u64,
    pub latency_p95_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchSummary {
    pub eval_path: String,
    pub endpoint: String,
    pub model: String,
    pub total_rows: usize,
    pub evaluated_rows: usize,
    pub error_rows: usize,
    pub fast_path_rows: usize,
    pub retried_rows: usize,
    pub slop_rate_pct: f64,
    pub numbers_preserved_pct: f64,
    pub tokens_preserved_pct: f64,
    pub surface_pass_pct: f64,
    pub grammar_clean_pct: f64,
    pub all_gates_pass_pct: f64,
    pub latency_p50_ms: u64,
    pub latency_p95_ms: u64,
    pub by_surface: BTreeMap<String, SurfaceBenchStats>,
}

/// Map Crucible eval task names to daemon `AiTaskId` strings.
pub fn map_eval_task_to_daemon_task(task: &str) -> &'static str {
    match task.trim().to_ascii_lowercase().as_str() {
        "fix_grammar_flow" => "fix_grammar_flow",
        "deslop" => "deslop",
        "shorten" => "shorten",
        "reply_draft" => "reply_draft",
        "direct" => "direct",
        "softer" => "softer",
        "bluf" => "bluf",
        "natural_english" => "natural_english",
        // polish_comment, polish_commit, rewrite_surface all map cleanly to rewrite_surface
        _ => "rewrite_surface",
    }
}

/// Parse a held-out evaluation JSONL file into typed rows.
pub fn parse_eval_jsonl(raw: &str) -> Result<Vec<EvalRow>> {
    let mut rows = Vec::new();
    for (idx, line) in raw.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let row: EvalRow = serde_json::from_str(trimmed)
            .with_context(|| format!("Invalid JSONL row on line {}", idx + 1))?;
        rows.push(row);
    }
    Ok(rows)
}

/// Compute nearest-rank percentile (0..=100) from a slice of millisecond latencies.
pub fn percentile_ms(samples: &[u64], pct: f64) -> u64 {
    if samples.is_empty() {
        return 0;
    }
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    let clamped = pct.clamp(0.0, 100.0);
    let rank = ((clamped / 100.0) * sorted.len() as f64).ceil() as usize;
    let idx = rank.saturating_sub(1).min(sorted.len() - 1);
    sorted[idx]
}

fn pct(numerator: usize, denominator: usize) -> f64 {
    if denominator == 0 {
        return 0.0;
    }
    ((numerator as f64 / denominator as f64) * 10000.0).round() / 100.0
}

/// Aggregate per-row benchmark outcomes into overall and per-surface metrics.
pub fn summarize_bench_outcomes(
    eval_path: &Path,
    endpoint: &str,
    outcomes: &[BenchRowOutcome],
) -> BenchSummary {
    let total_rows = outcomes.len();
    let ok_rows: Vec<&BenchRowOutcome> = outcomes.iter().filter(|r| r.ok).collect();
    let evaluated_rows = ok_rows.len();
    let error_rows = total_rows.saturating_sub(evaluated_rows);
    let fast_path_rows = ok_rows.iter().filter(|r| r.fast_path).count();
    let retried_rows = ok_rows.iter().filter(|r| r.retried).count();

    let slop_hits = ok_rows.iter().filter(|r| !r.zero_slop).count();
    let num_ok = ok_rows.iter().filter(|r| r.numbers_preserved).count();
    let tok_ok = ok_rows.iter().filter(|r| r.tokens_preserved).count();
    let surf_ok = ok_rows.iter().filter(|r| r.surface_compliant).count();
    let gram_ok = ok_rows.iter().filter(|r| r.grammar_clean).count();
    let all_ok = ok_rows
        .iter()
        .filter(|r| {
            r.zero_slop
                && r.numbers_preserved
                && r.tokens_preserved
                && r.surface_compliant
                && r.secrets_free
        })
        .count();

    let latencies: Vec<u64> = ok_rows.iter().map(|r| r.latency_ms).collect();
    let model = ok_rows
        .iter()
        .filter_map(|r| r.model.as_deref())
        .find(|m| *m != "tier0-deterministic")
        .or_else(|| ok_rows.iter().filter_map(|r| r.model.as_deref()).next())
        .unwrap_or("unknown")
        .to_owned();

    let mut grouped: BTreeMap<String, Vec<&BenchRowOutcome>> = BTreeMap::new();
    for item in outcomes {
        grouped
            .entry(item.surface_id.clone())
            .or_default()
            .push(item);
    }

    let mut by_surface = BTreeMap::new();
    for (surface, items) in grouped {
        let eval_items: Vec<&&BenchRowOutcome> = items.iter().filter(|i| i.ok).collect();
        let eval_n = eval_items.len();
        let surf_lat: Vec<u64> = eval_items.iter().map(|i| i.latency_ms).collect();
        by_surface.insert(
            surface,
            SurfaceBenchStats {
                total: items.len(),
                evaluated: eval_n,
                slop_rate_pct: pct(eval_items.iter().filter(|i| !i.zero_slop).count(), eval_n),
                numbers_preserved_pct: pct(
                    eval_items.iter().filter(|i| i.numbers_preserved).count(),
                    eval_n,
                ),
                tokens_preserved_pct: pct(
                    eval_items.iter().filter(|i| i.tokens_preserved).count(),
                    eval_n,
                ),
                surface_pass_pct: pct(
                    eval_items.iter().filter(|i| i.surface_compliant).count(),
                    eval_n,
                ),
                all_gates_pass_pct: pct(
                    eval_items
                        .iter()
                        .filter(|i| {
                            i.zero_slop
                                && i.numbers_preserved
                                && i.tokens_preserved
                                && i.surface_compliant
                                && i.secrets_free
                        })
                        .count(),
                    eval_n,
                ),
                latency_p50_ms: percentile_ms(&surf_lat, 50.0),
                latency_p95_ms: percentile_ms(&surf_lat, 95.0),
            },
        );
    }

    BenchSummary {
        eval_path: eval_path.display().to_string(),
        endpoint: endpoint.to_owned(),
        model,
        total_rows,
        evaluated_rows,
        error_rows,
        fast_path_rows,
        retried_rows,
        slop_rate_pct: pct(slop_hits, evaluated_rows),
        numbers_preserved_pct: pct(num_ok, evaluated_rows),
        tokens_preserved_pct: pct(tok_ok, evaluated_rows),
        surface_pass_pct: pct(surf_ok, evaluated_rows),
        grammar_clean_pct: pct(gram_ok, evaluated_rows),
        all_gates_pass_pct: pct(all_ok, evaluated_rows),
        latency_p50_ms: percentile_ms(&latencies, 50.0),
        latency_p95_ms: percentile_ms(&latencies, 95.0),
        by_surface,
    }
}

pub async fn run_bench(args: BenchArgs) -> Result<()> {
    let raw = fs::read_to_string(&args.eval)
        .with_context(|| format!("Failed to read eval file {}", args.eval.display()))?;
    let mut rows = parse_eval_jsonl(&raw)?;
    if let Some(ref surface_filter) = args.surface {
        rows.retain(|r| r.surface_id == *surface_filter);
    }
    if let Some(limit) = args.limit {
        rows.truncate(limit);
    }
    if rows.is_empty() {
        bail!("No evaluation rows matched in {}", args.eval.display());
    }

    let token = match args.token {
        Some(t) if !t.trim().is_empty() => t.trim().to_owned(),
        _ => {
            let token_path = default_token_path();
            fs::read_to_string(&token_path)
                .with_context(|| {
                    format!(
                        "Could not read daemon token at {}. Start `lexel-daemon serve` or pass --token.",
                        token_path.display()
                    )
                })?
                .trim()
                .to_owned()
        }
    };

    let base_url = args.endpoint.trim_end_matches('/');
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(90))
        .build()
        .context("Failed to create HTTP client")?;

    // Quick liveness probe before looping over the full eval set.
    client
        .get(format!("{base_url}/health"))
        .send()
        .await
        .with_context(|| {
            format!(
                "Could not connect to lexel-daemon at {base_url}. Start `lexel-daemon serve` first."
            )
        })?;

    let mut outcomes = Vec::with_capacity(rows.len());
    for row in &rows {
        let daemon_task = map_eval_task_to_daemon_task(&row.task);
        let started = Instant::now();
        let resp = client
            .post(format!("{base_url}/v1/rewrite"))
            .bearer_auth(&token)
            .json(&serde_json::json!({
                "text": row.source,
                "task": daemon_task,
                "surfaceId": row.surface_id,
                "subcontext": row.subcontext,
                "threadContext": row.thread_context,
            }))
            .send()
            .await;

        let wall_ms = started.elapsed().as_millis() as u64;
        match resp {
            Ok(r) if r.status().is_success() => {
                let body: serde_json::Value = r.json().await.unwrap_or_default();
                let suggestion = body
                    .get("suggestion")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_owned();
                let latency_ms = body
                    .get("latencyMs")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(wall_ms);
                let model = body
                    .get("model")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned);
                let fast_path = body
                    .get("fastPath")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let retried = body
                    .get("retried")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                // Always re-verify deterministically with Tier 2 lexel-core verifier for objective grading.
                let gates: GateCheckSummary =
                    verify_rewrite(&row.source, &suggestion, &row.surface_id, 0, &[])
                        .unwrap_or_else(|_| GateCheckSummary {
                            zero_slop: false,
                            numbers_preserved: false,
                            tokens_preserved: false,
                            surface_compliant: false,
                            grammar_clean: false,
                            secrets_free: true,
                            warnings: vec!["Tier 2 verification error".to_owned()],
                        });

                outcomes.push(BenchRowOutcome {
                    eval_id: row.eval_id.clone(),
                    surface_id: row.surface_id.clone(),
                    task: row.task.clone(),
                    ok: true,
                    error: None,
                    model,
                    fast_path,
                    retried,
                    latency_ms,
                    zero_slop: gates.zero_slop,
                    numbers_preserved: gates.numbers_preserved,
                    tokens_preserved: gates.tokens_preserved,
                    surface_compliant: gates.surface_compliant,
                    grammar_clean: gates.grammar_clean,
                    secrets_free: gates.secrets_free,
                    warnings: gates.warnings,
                    suggestion: Some(suggestion),
                    reference_target: row.reference_target.clone(),
                });
            }
            Ok(r) => {
                let status = r.status();
                let err_text = r
                    .json::<serde_json::Value>()
                    .await
                    .ok()
                    .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_owned))
                    .unwrap_or_else(|| format!("HTTP {status}"));
                outcomes.push(BenchRowOutcome {
                    eval_id: row.eval_id.clone(),
                    surface_id: row.surface_id.clone(),
                    task: row.task.clone(),
                    ok: false,
                    error: Some(err_text),
                    model: None,
                    fast_path: false,
                    retried: false,
                    latency_ms: wall_ms,
                    zero_slop: false,
                    numbers_preserved: false,
                    tokens_preserved: false,
                    surface_compliant: false,
                    grammar_clean: false,
                    secrets_free: true,
                    warnings: Vec::new(),
                    suggestion: None,
                    reference_target: row.reference_target.clone(),
                });
            }
            Err(err) => {
                outcomes.push(BenchRowOutcome {
                    eval_id: row.eval_id.clone(),
                    surface_id: row.surface_id.clone(),
                    task: row.task.clone(),
                    ok: false,
                    error: Some(err.to_string()),
                    model: None,
                    fast_path: false,
                    retried: false,
                    latency_ms: wall_ms,
                    zero_slop: false,
                    numbers_preserved: false,
                    tokens_preserved: false,
                    surface_compliant: false,
                    grammar_clean: false,
                    secrets_free: true,
                    warnings: Vec::new(),
                    suggestion: None,
                    reference_target: row.reference_target.clone(),
                });
            }
        }
    }

    if let Some(ref out_path) = args.out {
        if let Some(parent) = out_path.parent()
            && !parent.as_os_str().is_empty()
        {
            fs::create_dir_all(parent)?;
        }
        let mut lines = String::new();
        for item in &outcomes {
            lines.push_str(&serde_json::to_string(item)?);
            lines.push('\n');
        }
        fs::write(out_path, lines)
            .with_context(|| format!("Failed to write {}", out_path.display()))?;
    }

    let summary = summarize_bench_outcomes(&args.eval, base_url, &outcomes);
    if args.json {
        println!("{}", serde_json::to_string_pretty(&summary)?);
    } else {
        println!("Lexel Benchmark Summary");
        println!("  Eval file:       {}", summary.eval_path);
        println!("  Model:           {}", summary.model);
        println!(
            "  Evaluated:       {}/{} (errors: {}, fast-path: {}, retried: {})",
            summary.evaluated_rows,
            summary.total_rows,
            summary.error_rows,
            summary.fast_path_rows,
            summary.retried_rows
        );
        println!(
            "  Slop rate:       {:.2}% (lower is better)",
            summary.slop_rate_pct
        );
        println!("  Numbers kept:    {:.2}%", summary.numbers_preserved_pct);
        println!("  Code/URLs kept:  {:.2}%", summary.tokens_preserved_pct);
        println!("  Surface pass:    {:.2}%", summary.surface_pass_pct);
        println!("  All-gates pass:  {:.2}%", summary.all_gates_pass_pct);
        println!(
            "  Latency:         p50={}ms | p95={}ms",
            summary.latency_p50_ms, summary.latency_p95_ms
        );
        println!("\nPer-surface breakdown:");
        for (surf, stats) in &summary.by_surface {
            println!(
                "  {:<20} n={:<3} slop={:>5.1}% num={:>5.1}% tok={:>5.1}% surf={:>5.1}% p50={}ms p95={}ms",
                surf,
                stats.evaluated,
                stats.slop_rate_pct,
                stats.numbers_preserved_pct,
                stats.tokens_preserved_pct,
                stats.surface_pass_pct,
                stats.latency_p50_ms,
                stats.latency_p95_ms
            );
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_eval_rows_and_computes_percentiles_and_summary() {
        let jsonl = r#"{"eval_id":"e1","surface_id":"web_reddit","task":"polish_commit","subcontext":"r/rust","source":"Cut latency by 40% using `serde`.","reference_target":"Cut latency by 40% using `serde`."}"#;
        let rows = parse_eval_jsonl(jsonl).expect("parse jsonl");
        assert_eq!(rows.len(), 1);
        assert_eq!(
            map_eval_task_to_daemon_task(&rows[0].task),
            "rewrite_surface"
        );
        assert_eq!(percentile_ms(&[100, 200, 300, 400, 500], 50.0), 300);
        assert_eq!(percentile_ms(&[100, 200, 300, 400, 500], 95.0), 500);

        let outcomes = vec![
            BenchRowOutcome {
                eval_id: "e1".to_owned(),
                surface_id: "web_reddit".to_owned(),
                task: "deslop".to_owned(),
                ok: true,
                error: None,
                model: Some("lexel-1.5b".to_owned()),
                fast_path: false,
                retried: false,
                latency_ms: 210,
                zero_slop: true,
                numbers_preserved: true,
                tokens_preserved: true,
                surface_compliant: true,
                grammar_clean: true,
                secrets_free: true,
                warnings: vec![],
                suggestion: Some("Clean output.".to_owned()),
                reference_target: None,
            },
            BenchRowOutcome {
                eval_id: "e2".to_owned(),
                surface_id: "web_reddit".to_owned(),
                task: "deslop".to_owned(),
                ok: true,
                error: None,
                model: Some("lexel-1.5b".to_owned()),
                fast_path: false,
                retried: true,
                latency_ms: 480,
                zero_slop: false,
                numbers_preserved: true,
                tokens_preserved: false,
                surface_compliant: true,
                grammar_clean: true,
                secrets_free: true,
                warnings: vec!["slop".to_owned()],
                suggestion: Some("Delve output.".to_owned()),
                reference_target: None,
            },
        ];

        let summary =
            summarize_bench_outcomes(Path::new("eval.jsonl"), "http://127.0.0.1:42424", &outcomes);
        assert_eq!(summary.evaluated_rows, 2);
        assert_eq!(summary.slop_rate_pct, 50.0);
        assert_eq!(summary.numbers_preserved_pct, 100.0);
        assert_eq!(summary.tokens_preserved_pct, 50.0);
        assert_eq!(summary.surface_pass_pct, 100.0);
        assert_eq!(summary.latency_p50_ms, 210);
        assert_eq!(summary.latency_p95_ms, 480);
    }
}
