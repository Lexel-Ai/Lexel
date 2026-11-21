use std::fs;
use std::process::Command;

use lexel_db::LexelDb;

fn lexel_bin() -> &'static str {
    env!("CARGO_BIN_EXE_lexel")
}

#[test]
fn cli_ci_mode_sarif_and_repo_config_enforce_exit_codes() {
    let dir = std::env::temp_dir().join(format!("lexel-cli-ci-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("mkdir");

    fs::write(
        dir.join(".lexel.toml"),
        r#"
dictionary = ["Krakatoax"]
banned_slop_terms = ["synergize => combine"]
[docs]
max_line_chars = 120
"#,
    )
    .expect("write .lexel.toml");

    let dirty = dir.join("dirty.md");
    fs::write(
        &dirty,
        "We should synergize our Kraka-free roadmap and delve into details.\n",
    )
    .expect("write dirty");

    let out = Command::new(lexel_bin())
        .args(["check", "--ci", "--format", "sarif"])
        .arg(&dirty)
        .output()
        .expect("run lexel check --ci");
    assert_eq!(out.status.code(), Some(1));
    let sarif: serde_json::Value =
        serde_json::from_slice(&out.stdout).expect("valid SARIF JSON output");
    assert_eq!(sarif["version"], "2.1.0");
    let results = sarif["runs"][0]["results"]
        .as_array()
        .expect("results array");
    assert!(!results.is_empty(), "expected SARIF findings");

    let clean = dir.join("clean.md");
    fs::write(&clean, "Krakatoax compiles locally in under 5ms.\n").expect("write clean");
    let clean_out = Command::new(lexel_bin())
        .args(["check", "--ci", "--format", "json"])
        .arg(&clean)
        .output()
        .expect("run lexel check --ci clean");
    assert_eq!(clean_out.status.code(), Some(0));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn cli_voice_import_and_db_export_simpo_and_doctor_json_work() {
    let dir = std::env::temp_dir().join(format!("lexel-cli-db-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("mkdir");
    let db_path = dir.join("lexel.db");
    let sample_md = dir.join("notes.md");
    fs::write(
        &sample_md,
        "Switching our parser to borrowed slices dropped p99 latency from 4.8ms to 0.9ms.\n\nLocal deterministic linting catches typos before any model wakes up.\n",
    )
    .expect("write notes");

    // 1. Voice import from files
    let imp = Command::new(lexel_bin())
        .args([
            "voice",
            "import",
            "--db",
            db_path.to_str().unwrap(),
            "--files",
            sample_md.to_str().unwrap(),
            "--json",
        ])
        .output()
        .expect("voice import");
    assert!(
        imp.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&imp.stderr)
    );
    let imp_json: serde_json::Value = serde_json::from_slice(&imp.stdout).expect("json");
    assert_eq!(imp_json["importedCount"], 2);

    // 2. Seed an edited example with PII and export SimPO JSONL
    {
        let db = LexelDb::open(&db_path).expect("open db");
        db.save_voice_example(
            "web_email",
            Some("gmail"),
            "Just wanted to seamlessly reach alice@example.com about ticket #42.",
            "Please update alice@example.com on ticket #42 today.",
            "edited",
        )
        .expect("save edited");
    }

    let simpo_out = dir.join("simpo.jsonl");
    let exp = Command::new(lexel_bin())
        .args([
            "db",
            "export-simpo",
            "--db",
            db_path.to_str().unwrap(),
            "--out",
            simpo_out.to_str().unwrap(),
        ])
        .output()
        .expect("db export-simpo");
    assert!(
        exp.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&exp.stderr)
    );
    let raw_jsonl = fs::read_to_string(&simpo_out).expect("read simpo jsonl");
    let first_line: serde_json::Value =
        serde_json::from_str(raw_jsonl.lines().next().expect("one pair")).expect("valid jsonl");
    assert_eq!(first_line["origin"], "lexel_user_feedback");
    assert_eq!(first_line["perturbation_type"], "user_edit");
    assert!(
        first_line["chosen"]
            .as_str()
            .unwrap()
            .contains("[REDACTED_EMAIL]")
    );

    // 3. Doctor standalone JSON (point at closed port so it runs deterministic standalone check)
    let doc = Command::new(lexel_bin())
        .args(["doctor", "--endpoint", "http://127.0.0.1:1", "--json"])
        .output()
        .expect("doctor");
    assert!(
        doc.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&doc.stderr)
    );
    let doc_json: serde_json::Value = serde_json::from_slice(&doc.stdout).expect("doctor json");
    assert_eq!(doc_json["ok"], true);
    assert!(doc_json["tier0LatencyMs"].as_f64().unwrap() >= 0.0);

    // 4. Voice import from --git-log against current repo with limit 5
    let git_imp = Command::new(lexel_bin())
        .args([
            "voice",
            "import",
            "--db",
            db_path.to_str().unwrap(),
            "--git-log",
            "--repo",
            env!("CARGO_MANIFEST_DIR"),
            "--limit",
            "5",
            "--json",
        ])
        .output()
        .expect("voice import git-log");
    assert!(
        git_imp.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&git_imp.stderr)
    );
    let git_json: serde_json::Value = serde_json::from_slice(&git_imp.stdout).expect("git json");
    assert_eq!(git_json["sourceKind"], "git_log");

    // 5. Weekly insights JSON and crutch-word ban CLI
    let ban = Command::new(lexel_bin())
        .args([
            "db",
            "crutch-words",
            "ban",
            "basically",
            "--db",
            db_path.to_str().unwrap(),
        ])
        .output()
        .expect("crutch ban");
    assert!(ban.status.success());

    let insights = Command::new(lexel_bin())
        .args([
            "db",
            "insights",
            "--db",
            db_path.to_str().unwrap(),
            "--days",
            "7",
            "--json",
        ])
        .output()
        .expect("db insights");
    assert!(insights.status.success());
    let ins_json: serde_json::Value = serde_json::from_slice(&insights.stdout).expect("insights");
    assert!(
        ins_json["bannedCrutchWords"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "basically")
    );

    let _ = fs::remove_dir_all(&dir);
}
