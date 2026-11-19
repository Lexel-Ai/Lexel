use lexel_core::{MainModelTier, UnifiedSettings};
use lexel_db::{DatabaseBackup, LexelDb};
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
