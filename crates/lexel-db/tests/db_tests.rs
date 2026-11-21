use lexel_core::{MainModelTier, UnifiedSettings};
use lexel_db::{DatabaseBackup, LexelDb, VoiceImportSample, scrub_pii_for_export};
use serde_json::json;

#[test]
fn initializes_default_profile_and_supports_switching() {
    let db = LexelDb::open_in_memory().expect("in-memory db");
    let active = db.active_profile().expect("default profile");
    assert_eq!(active.id, "default");
    assert_eq!(active.name, "Default");
    assert!(active.is_active);
    assert_eq!(active.settings.main_model_tier, MainModelTier::Lexel15B);

    let work = db
        .create_profile("Work", true, true)
        .expect("create work profile");
    assert_eq!(work.name, "Work");
    assert!(work.is_active);
    assert_eq!(db.list_profiles().unwrap().len(), 2);

    let updated = db.set_main_model("0.5b").expect("set main model 0.5b");
    assert_eq!(updated.settings.main_model_tier, MainModelTier::Lexel05B);
    assert_eq!(updated.settings.effective_model_name(), "qwen2.5:0.5b");

    // Switching back to Default keeps its own independent 1.5B setting.
    let back = db.switch_profile("default").expect("switch back");
    assert_eq!(back.settings.main_model_tier, MainModelTier::Lexel15B);
}

#[test]
fn patches_settings_and_persists_fts5_voice_memory() {
    let db = LexelDb::open_in_memory().expect("in-memory db");
    let patched = db
        .patch_active_settings(json!({
            "aiEnabled": false,
            "dialect": 1,
            "userDictionary": ["Weirpack", "Lexel"]
        }))
        .expect("patch");
    assert!(!patched.settings.ai_enabled);
    assert_eq!(patched.settings.dialect, 1);
    assert_eq!(patched.settings.user_dictionary, vec!["Weirpack", "Lexel"]);

    let saved = db
        .save_voice_example(
            "web_reddit",
            Some("r/rust"),
            "Verbose draft",
            "Tokio allocator tail latency stayed steady at 18ms.",
            "accepted",
        )
        .expect("save voice");
    let matches = db
        .search_voice_examples("web_reddit", "allocator latency", 2)
        .expect("fts search");
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].id, saved.id);

    let backup: DatabaseBackup = db.export_backup().expect("export");
    db.purge_all().expect("purge");
    assert!(db.list_voice_examples(None, 20).unwrap().is_empty());

    let restored = db.import_backup(backup).expect("import");
    assert_eq!(restored.settings.dialect, 1);
    assert_eq!(db.list_voice_examples(None, 20).unwrap().len(), 1);

    let clean_settings = UnifiedSettings {
        ai_enabled: true,
        ..UnifiedSettings::default()
    };
    db.update_active_settings(&clean_settings).unwrap();
    assert!(db.active_profile().unwrap().settings.ai_enabled);
}

#[test]
fn failed_backup_import_rolls_back_without_wiping_existing_data() {
    let db = LexelDb::open_in_memory().expect("in-memory db");
    db.patch_active_settings(json!({ "dialect": 2, "userDictionary": ["KeepMe"] }))
        .expect("patch");
    db.save_voice_example("general", None, "Old", "Kept voice example.", "accepted")
        .expect("voice");

    let mut bad_backup = db.export_backup().expect("export");
    // Corrupt foreign key: point a voice example to a profile ID that does not exist.
    bad_backup.voice_examples[0].profile_id = "missing-profile".to_owned();

    assert!(db.import_backup(bad_backup).is_err());

    let after = db.active_profile().expect("profile preserved");
    assert_eq!(after.settings.dialect, 2);
    assert_eq!(after.settings.user_dictionary, vec!["KeepMe"]);
    assert_eq!(db.list_voice_examples(None, 20).unwrap().len(), 1);
}

#[test]
fn local_writing_stats_and_draft_snapshots_persist_and_purge() {
    let db = LexelDb::open_in_memory().expect("in-memory db");
    db.record_writing_event("web_reddit", 42, 2, 3, 1, 4)
        .expect("record event 1");
    db.record_writing_event("web_reddit", 18, 1, 0, 0, 1)
        .expect("record event 2");
    db.record_writing_event("web_email", 30, 0, 1, 0, 2)
        .expect("record event 3");

    let stats = db.writing_stats_summary().expect("stats summary");
    assert_eq!(stats.total_checks, 3);
    assert_eq!(stats.total_words_checked, 90);
    assert_eq!(stats.total_grammar_hits, 3);
    assert_eq!(stats.total_slop_hits, 4);
    assert_eq!(stats.total_secret_blocks, 1);
    assert_eq!(stats.total_fixes_applied, 7);
    assert_eq!(stats.top_surfaces[0], ("web_reddit".to_owned(), 2));

    let snap = db
        .save_draft_snapshot("web_email", None, "Hello team,\nReady to ship v1.")
        .expect("save snapshot");
    assert_eq!(snap.title, "Hello team,");
    assert_eq!(snap.word_count, 6);
    assert_eq!(db.list_draft_snapshots(20).expect("list drafts").len(), 1);

    db.purge_all().expect("purge all");
    assert_eq!(
        db.writing_stats_summary()
            .expect("empty stats")
            .total_checks,
        0
    );
    assert!(
        db.list_draft_snapshots(20)
            .expect("empty drafts")
            .is_empty()
    );
}

#[test]
fn voice_import_simpo_export_crutch_bans_and_weekly_insights_work_end_to_end() {
    let db = LexelDb::open_in_memory().expect("in-memory db");

    // 1. Voice cold-start import with deduplication and secret skipping
    let report = db
        .import_voice_samples(
            "paste",
            &[
                VoiceImportSample {
                    surface_id: "web_github_pr".to_owned(),
                    text: "Switched parser to borrowed slices, cutting p99 latency from 4.8ms to 0.9ms.".to_owned(),
                    original: None,
                },
                VoiceImportSample {
                    surface_id: "web_github_pr".to_owned(),
                    text: "Switched parser to borrowed slices, cutting p99 latency from 4.8ms to 0.9ms.".to_owned(),
                    original: None,
                },
                VoiceImportSample {
                    surface_id: "general".to_owned(),
                    text: "Never store sk_live_abcdefghijklmnop1234567890 in voice memory.".to_owned(),
                    original: None,
                },
            ],
        )
        .expect("import voice samples");
    assert_eq!(report.imported_count, 1);
    assert_eq!(report.skipped_count, 2);
    assert_eq!(report.style_stats.total_examples, 1);

    // 2. Save edited + rejected examples containing PII and verify SimPO export scrubs PII
    db.save_voice_example(
        "web_email",
        Some("gmail"),
        "Just wanted to seamlessly delve into alice@example.com about 192.168.1.50.",
        "Please contact alice@example.com regarding 192.168.1.50 by Friday.",
        "edited",
    )
    .expect("save edited");
    db.save_voice_example(
        "web_slack",
        Some("#eng"),
        "Deploying v2 at 14:00 UTC.",
        "We are delighted to seamlessly deploy v2 at 14:00 UTC.",
        "rejected",
    )
    .expect("save rejected");

    let pairs = db
        .export_simpo_pairs(None, false, 50)
        .expect("export simpo");
    assert_eq!(pairs.len(), 2);
    let email_pair = pairs
        .iter()
        .find(|p| p.surface_id == "web_email")
        .expect("email pair");
    assert!(!email_pair.chosen.contains("alice@example.com"));
    assert!(!email_pair.chosen.contains("192.168.1.50"));
    assert!(email_pair.chosen.contains("[REDACTED_EMAIL]"));
    assert!(email_pair.chosen.contains("[REDACTED_IP]"));

    let slack_pair = pairs
        .iter()
        .find(|p| p.surface_id == "web_slack")
        .expect("slack pair");
    assert_eq!(slack_pair.chosen, "Deploying v2 at 14:00 UTC.");
    assert!(slack_pair.rejected.contains("seamlessly"));

    assert_eq!(
        scrub_pii_for_export("Call 415-555-0199 or bob@acme.io"),
        "Call [REDACTED_PHONE] or [REDACTED_EMAIL]"
    );

    // 3. Crutch-word bans sync to custom_slop_terms
    let bans = db.toggle_crutch_word_ban("just", true).expect("ban just");
    assert_eq!(bans, vec!["just"]);
    assert!(
        db.active_profile()
            .unwrap()
            .settings
            .custom_slop_terms
            .iter()
            .any(|t| t == "just")
    );

    // 4. Weekly insights aggregates local events, crutch words, and slop patterns
    db.record_writing_event("web_email", 120, 2, 3, 1, 4)
        .expect("record event");
    db.record_pattern_hits("crutch", &["just".to_owned(), "actually".to_owned()])
        .expect("record crutch");
    db.record_pattern_hits("slop", &["delve".to_owned()])
        .expect("record slop");

    let insights = db.weekly_insights(7).expect("weekly insights");
    assert_eq!(insights.checks_in_period, 1);
    assert_eq!(insights.words_in_period, 120);
    assert_eq!(insights.slop_caught_in_period, 3);
    assert_eq!(insights.secrets_blocked_in_period, 1);
    assert!(
        insights
            .top_crutch_words
            .iter()
            .any(|c| c.word == "just" && c.banned && c.count >= 2)
    );
    assert!(
        insights
            .top_slop_patterns
            .iter()
            .any(|(term, _)| term == "delve")
    );
}
