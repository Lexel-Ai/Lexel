use std::fs;
use std::process::Command;

fn lexel_bin() -> &'static str {
    env!("CARGO_BIN_EXE_lexel")
}

#[test]
fn cli_check_sarif_fix_all_and_fail_on_secrets_work() {
    let tmp = std::env::temp_dir().join(format!("lexel-cli-test-{}", uuid_stub()));
    fs::create_dir_all(&tmp).expect("tmp dir");
    let draft_path = tmp.join("note.md");
    fs::write(
        &draft_path,
        "We delve into an typo — with token sk_live_abcdefghijklmnop1234567890.\n",
    )
    .expect("write draft");

    let sarif_out = Command::new(lexel_bin())
        .args([
            "check",
            draft_path.to_str().unwrap(),
            "--format",
            "sarif",
            "--fail-on",
            "secrets",
        ])
        .output()
        .expect("run lexel check sarif");
    assert_eq!(sarif_out.status.code(), Some(1));
    let sarif_json: serde_json::Value =
        serde_json::from_slice(&sarif_out.stdout).expect("parse sarif");
    assert_eq!(sarif_json["version"], "2.1.0");
    let results = sarif_json["runs"][0]["results"]
        .as_array()
        .expect("results");
    assert!(!results.is_empty());

    let clean_path = tmp.join("clean.txt");
    fs::write(&clean_path, "We should delve into an typo — fast.\n").expect("write clean");
    let fix_out = Command::new(lexel_bin())
        .args([
            "check",
            clean_path.to_str().unwrap(),
            "--fix-all",
            "--write",
            "--format",
            "json",
        ])
        .output()
        .expect("run lexel check --fix-all --write");
    assert!(
        fix_out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&fix_out.stderr)
    );
    let updated = fs::read_to_string(&clean_path).expect("read fixed file");
    assert!(updated.contains("explore a typo"), "got: {updated}");
    assert!(!updated.contains('—'));

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn cli_stats_transforms_synonyms_and_weirpack_roundtrip() {
    let tmp = std::env::temp_dir().join(format!("lexel-cli-pack-{}", uuid_stub()));
    fs::create_dir_all(&tmp).expect("tmp dir");
    let pack_path = tmp.join("antislop.weirpack");

    let stats_out = Command::new(lexel_bin())
        .args(["stats", "--json"])
        .env_remove("RUST_LOG")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write;
            if let Some(mut stdin) = child.stdin.take() {
                stdin.write_all(b"Short tests verify code cleanly.")?;
            }
            child.wait_with_output()
        })
        .expect("run stats");
    assert!(stats_out.status.success());
    let stats_json: serde_json::Value = serde_json::from_slice(&stats_out.stdout).expect("json");
    assert_eq!(stats_json["readability"]["words"], 5);

    let sc_out = Command::new(lexel_bin())
        .args(["sentence-case", "--text", "HELLO WORLD. SECOND LINE!"])
        .output()
        .expect("sentence-case");
    assert!(sc_out.status.success());
    assert_eq!(
        String::from_utf8_lossy(&sc_out.stdout),
        "Hello world. Second line!"
    );

    let syn_out = Command::new(lexel_bin())
        .args(["synonyms", "fast", "--json"])
        .output()
        .expect("synonyms");
    assert!(syn_out.status.success());
    let syns: Vec<String> = serde_json::from_slice(&syn_out.stdout).expect("syns json");
    assert!(!syns.is_empty());

    let build_out = Command::new(lexel_bin())
        .args(["weirpack", "build-antislop", pack_path.to_str().unwrap()])
        .output()
        .expect("build-antislop");
    assert!(build_out.status.success());

    let validate_out = Command::new(lexel_bin())
        .args([
            "weirpack",
            "validate",
            pack_path.to_str().unwrap(),
            "--json",
        ])
        .output()
        .expect("validate weirpack");
    assert!(validate_out.status.success());
    let val_json: serde_json::Value = serde_json::from_slice(&validate_out.stdout).expect("json");
    assert_eq!(val_json["ruleCount"], 10);

    let _ = fs::remove_dir_all(&tmp);
}

fn uuid_stub() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(1)
}
