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
