use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use lexel_core::{
    AiTaskId, ChatMessage, LexelProfile, MainModelTier, SlopScanner, SurfaceCatalog,
    UnifiedSettings, VoiceExample, analyze_readability, build_rewrite_messages_with_surfaces,
    scan_secrets,
};
use regex::Regex;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("core error: {0}")]
    Core(#[from] lexel_core::CoreError),
    #[error("profile not found: {0}")]
    ProfileNotFound(String),
    #[error("cannot delete the last remaining profile")]
    CannotDeleteLastProfile,
    #[error("invalid backup payload: {0}")]
    InvalidBackup(String),
    #[error("import error: {0}")]
    Import(String),
}

/// One human writing sample passed into cold-start voice import.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VoiceImportSample {
    pub surface_id: String,
    pub text: String,
    #[serde(default)]
    pub original: Option<String>,
}

/// Aggregated stylistic fingerprint derived from local `voice_examples`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStyleStats {
    pub total_examples: usize,
    pub avg_sentence_words: f64,
    pub avg_word_length: f64,
    pub directness_score: u8,
    pub em_dash_free_rate: f64,
    pub top_surfaces: Vec<(String, usize)>,
    pub sample_openers: Vec<String>,
}

/// Summary returned after seeding `voice_examples` from pasted samples, Git commits, or files.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VoiceImportReport {
    pub imported_count: usize,
    pub skipped_count: usize,
    pub source_kind: String,
    pub style_stats: VoiceStyleStats,
}

/// Character-level difference span on `rejected` relative to `chosen` for SimPO/DPO credit assignment.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PerturbedSpan {
    pub original: String,
    pub perturbed: String,
    pub start_char: usize,
    pub end_char: usize,
    pub perturbation_type: String,
}

/// PII-scrubbed SimPO/DPO preference training pair exported from local `voice_examples`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SimpoExportPair {
    pub pair_id: String,
    pub example_id: String,
    pub surface_id: String,
    pub task: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subcontext: Option<String>,
    pub source: String,
    pub prompt: String,
    pub chosen: String,
    pub rejected: String,
    pub perturbation_type: String,
    pub perturbed_spans: Vec<PerturbedSpan>,
    pub rejected_token_mask: Vec<u8>,
    pub origin: String,
    pub messages: Vec<ChatMessage>,
    pub created_at: i64,
}

/// Crutch-word usage frequency and ban status for Private Weekly Insights.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CrutchWordStat {
    pub word: String,
    pub count: usize,
    pub banned: bool,
}

/// One UTC calendar day bucket of local writing metrics (counts only, zero raw text).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DailyWritingBucket {
    pub day_utc: String,
    pub checks: usize,
    pub words: usize,
    pub slop_hits: usize,
    pub grammar_hits: usize,
    pub fixes_applied: usize,
}

/// Local-only Private Weekly Writing Insights aggregated strictly from SQLite.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyInsightsReport {
    pub period_days: usize,
    pub checks_in_period: usize,
    pub words_in_period: usize,
    pub slop_caught_in_period: usize,
    pub grammar_hits_in_period: usize,
    pub secrets_blocked_in_period: usize,
    pub fixes_applied_in_period: usize,
    pub clarity_score: u8,
    pub clarity_delta: i16,
    pub conciseness_score: u8,
    pub conciseness_delta: i16,
    pub top_crutch_words: Vec<CrutchWordStat>,
    pub banned_crutch_words: Vec<String>,
    pub top_slop_patterns: Vec<(String, usize)>,
    pub daily_buckets: Vec<DailyWritingBucket>,
    pub voice_examples_count: usize,
}

/// Complete portable JSON backup of a Lexel local database.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseBackup {
    pub version: u32,
    pub exported_at: i64,
    pub profiles: Vec<LexelProfile>,
    pub voice_examples: Vec<VoiceExample>,
}

/// Aggregated local-only writing statistics (counts only; never stores raw user text).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WritingStatsSummary {
    pub total_checks: usize,
    pub total_words_checked: usize,
    pub total_grammar_hits: usize,
    pub total_slop_hits: usize,
    pub total_secret_blocks: usize,
    pub total_fixes_applied: usize,
    pub top_surfaces: Vec<(String, usize)>,
}

/// Opt-in saved scratchpad draft snapshot stored locally in SQLite.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DraftSnapshot {
    pub id: String,
    pub profile_id: String,
    pub surface_id: String,
    pub title: String,
    pub content: String,
    pub word_count: usize,
    pub created_at: i64,
}

/// Return the canonical platform-specific Lexel data directory.
/// Matches `scripts/setup-models.sh` (`~/.local/share/lexel` on Linux,
/// `~/Library/Application Support/lexel` on macOS, `%APPDATA%\lexel` on Windows).
pub fn default_data_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("lexel")
    }
    #[cfg(target_os = "windows")]
    {
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("lexel")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("lexel")
    }
}

/// Return the default path to `lexel.db`.
pub fn default_db_path() -> PathBuf {
    default_data_dir().join("lexel.db")
}

/// Return the default directory containing downloaded GGUF models.
pub fn default_models_dir() -> PathBuf {
    default_data_dir().join("models")
}

/// Return the default path to the daemon's per-install Bearer token file.
pub fn default_token_path() -> PathBuf {
    default_data_dir().join("daemon.token")
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// SQLite + FTS5 local storage for unified Lexel settings, profiles, and voice memory.
pub struct LexelDb {
    conn: Connection,
}

impl LexelDb {
    /// Open (or initialize) a file-backed `lexel.db` database.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, DbError> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                DbError::Sqlite(rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
            })?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "busy_timeout", 5000)?;
        let db = Self { conn };
        db.init_schema()?;
        Ok(db)
    }

    /// Open an isolated in-memory database (used by tests).
    pub fn open_in_memory() -> Result<Self, DbError> {
        let conn = Connection::open_in_memory()?;
        let db = Self { conn };
        db.init_schema()?;
        Ok(db)
    }

    fn init_schema(&self) -> Result<(), DbError> {
        self.conn.execute_batch(
            r#"
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS profiles (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 0,
                settings_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS surface_profiles (
                id TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                register TEXT NOT NULL,
                rules_json TEXT NOT NULL,
                prompt_directive TEXT NOT NULL,
                ai_enabled_by_default INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS sub_contexts (
                id TEXT PRIMARY KEY,
                profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                surface_id TEXT NOT NULL,
                subcontext TEXT NOT NULL,
                override_directive TEXT,
                preferred_prefix TEXT,
                updated_at INTEGER NOT NULL,
                UNIQUE(profile_id, surface_id, subcontext)
            );

            CREATE TABLE IF NOT EXISTS voice_examples (
                id TEXT PRIMARY KEY,
                profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                surface_id TEXT NOT NULL,
                subcontext TEXT,
                original TEXT NOT NULL,
                rewritten TEXT NOT NULL,
                action TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_voice_examples_profile_surface
                ON voice_examples(profile_id, surface_id, created_at DESC);

            CREATE VIRTUAL TABLE IF NOT EXISTS voice_examples_fts USING fts5(
                id UNINDEXED,
                profile_id UNINDEXED,
                surface_id UNINDEXED,
                original,
                rewritten
            );

            CREATE TABLE IF NOT EXISTS writing_events (
                id TEXT PRIMARY KEY,
                profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                surface_id TEXT NOT NULL,
                words_checked INTEGER NOT NULL DEFAULT 0,
                grammar_hits INTEGER NOT NULL DEFAULT 0,
                slop_hits INTEGER NOT NULL DEFAULT 0,
                secret_blocks INTEGER NOT NULL DEFAULT 0,
                fixes_applied INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_writing_events_profile
                ON writing_events(profile_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS draft_snapshots (
                id TEXT PRIMARY KEY,
                profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                surface_id TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                word_count INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_draft_snapshots_profile
                ON draft_snapshots(profile_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS crutch_word_bans (
                profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                word TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (profile_id, word)
            );

            CREATE TABLE IF NOT EXISTS writing_pattern_hits (
                profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                kind TEXT NOT NULL,
                term TEXT NOT NULL,
                hit_count INTEGER NOT NULL DEFAULT 1,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (profile_id, kind, term)
            );
            "#,
        )?;

        self.seed_surfaces()?;
        self.ensure_default_profile()?;
        Ok(())
    }

    fn seed_surfaces(&self) -> Result<(), DbError> {
        let catalog = SurfaceCatalog::load_embedded()?;
        let mut stmt = self.conn.prepare(
            "INSERT OR IGNORE INTO surface_profiles (id, label, register, rules_json, prompt_directive, ai_enabled_by_default)
             VALUES (?1, ?2, ?3, ?4, ?5, 1)",
        )?;
        for s in catalog.all() {
            let rules_json = serde_json::to_string(s)?;
            stmt.execute(params![
                s.id,
                s.label,
                s.register,
                rules_json,
                s.prompt_directive
            ])?;
        }
        Ok(())
    }

    fn ensure_default_profile(&self) -> Result<(), DbError> {
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get(0))?;
        if count == 0 {
            let now = now_millis();
            let settings_json = serde_json::to_string(&UnifiedSettings::default())?;
            self.conn.execute(
                "INSERT INTO profiles (id, name, is_active, settings_json, created_at, updated_at)
                 VALUES ('default', 'Default', 1, ?1, ?2, ?2)",
                params![settings_json, now],
            )?;
            return Ok(());
        }

        let active_count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM profiles WHERE is_active = 1",
            [],
            |r| r.get(0),
        )?;
        if active_count == 0 {
            self.conn.execute(
                "UPDATE profiles SET is_active = 1 WHERE id = (SELECT id FROM profiles ORDER BY created_at ASC LIMIT 1)",
                [],
            )?;
        }
        Ok(())
    }

    fn parse_profile_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LexelProfile> {
        let id: String = row.get(0)?;
        let name: String = row.get(1)?;
        let is_active_int: i64 = row.get(2)?;
        let settings_json: String = row.get(3)?;
        let created_at: i64 = row.get(4)?;
        let updated_at: i64 = row.get(5)?;

        let settings: UnifiedSettings =
            serde_json::from_str(&settings_json).unwrap_or_else(|_| UnifiedSettings::default());
        Ok(LexelProfile {
            id,
            name,
            is_active: is_active_int != 0,
            settings,
            created_at,
            updated_at,
        })
    }

    /// List all local profiles/accounts ordered by creation time.
    pub fn list_profiles(&self) -> Result<Vec<LexelProfile>, DbError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, is_active, settings_json, created_at, updated_at
             FROM profiles ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], Self::parse_profile_row)?;
        let mut out = Vec::new();
        for item in rows {
            out.push(item?);
        }
        Ok(out)
    }

    /// Fetch the active local profile.
    pub fn active_profile(&self) -> Result<LexelProfile, DbError> {
        self.ensure_default_profile()?;
        self.conn
            .query_row(
                "SELECT id, name, is_active, settings_json, created_at, updated_at
                 FROM profiles WHERE is_active = 1 LIMIT 1",
                [],
                Self::parse_profile_row,
            )
            .map_err(DbError::from)
    }

    /// Fetch a specific profile by ID.
    pub fn get_profile(&self, id: &str) -> Result<LexelProfile, DbError> {
        self.conn
            .query_row(
                "SELECT id, name, is_active, settings_json, created_at, updated_at
                 FROM profiles WHERE id = ?1",
                params![id],
                Self::parse_profile_row,
            )
            .optional()?
            .ok_or_else(|| DbError::ProfileNotFound(id.to_owned()))
    }

    /// Create a new local profile/account (optionally cloning settings from the active profile).
    pub fn create_profile(
        &self,
        name: &str,
        clone_from_active: bool,
        activate: bool,
    ) -> Result<LexelProfile, DbError> {
        let clean_name = name.trim();
        let display_name = if clean_name.is_empty() {
            "New Profile"
        } else {
            clean_name
        };
        let settings = if clone_from_active {
            self.active_profile()?.settings
        } else {
            UnifiedSettings::default()
        };
        let id = Uuid::new_v4().to_string();
        let now = now_millis();
        let settings_json = serde_json::to_string(&settings)?;

        if activate {
            self.conn.execute("UPDATE profiles SET is_active = 0", [])?;
        }
        self.conn.execute(
            "INSERT INTO profiles (id, name, is_active, settings_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![
                id,
                display_name,
                if activate { 1 } else { 0 },
                settings_json,
                now
            ],
        )?;
        self.get_profile(&id)
    }

    /// Switch the active local profile/account across all connected apps.
    pub fn switch_profile(&self, id: &str) -> Result<LexelProfile, DbError> {
        let _ = self.get_profile(id)?;
        self.conn.execute("UPDATE profiles SET is_active = 0", [])?;
        self.conn.execute(
            "UPDATE profiles SET is_active = 1, updated_at = ?2 WHERE id = ?1",
            params![id, now_millis()],
        )?;
        self.get_profile(id)
    }

    /// Rename a profile.
    pub fn rename_profile(&self, id: &str, name: &str) -> Result<LexelProfile, DbError> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return self.get_profile(id);
        }
        let changed = self.conn.execute(
            "UPDATE profiles SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, trimmed, now_millis()],
        )?;
        if changed == 0 {
            return Err(DbError::ProfileNotFound(id.to_owned()));
        }
        self.get_profile(id)
    }

    /// Delete a profile unless it is the sole remaining profile.
    pub fn delete_profile(&self, id: &str) -> Result<LexelProfile, DbError> {
        let profiles = self.list_profiles()?;
        if profiles.len() <= 1 {
            return Err(DbError::CannotDeleteLastProfile);
        }
        let target = profiles
            .iter()
            .find(|p| p.id == id)
            .ok_or_else(|| DbError::ProfileNotFound(id.to_owned()))?;

        // Clean FTS entries belonging to this profile before cascade delete.
        self.conn.execute(
            "DELETE FROM voice_examples_fts WHERE profile_id = ?1",
            params![id],
        )?;
        self.conn
            .execute("DELETE FROM profiles WHERE id = ?1", params![id])?;

        if target.is_active
            && let Some(next) = profiles.iter().find(|p| p.id != id)
        {
            return self.switch_profile(&next.id);
        }
        self.active_profile()
    }

    /// Replace settings on the currently active profile.
    pub fn update_active_settings(
        &self,
        settings: &UnifiedSettings,
    ) -> Result<LexelProfile, DbError> {
        let active = self.active_profile()?;
        let now = now_millis();
        let json = serde_json::to_string(settings)?;
        self.conn.execute(
            "UPDATE profiles SET settings_json = ?2, updated_at = ?3 WHERE id = ?1",
            params![active.id, json, now],
        )?;
        self.get_profile(&active.id)
    }

    /// Merge partial JSON fields into the active profile's `UnifiedSettings`.
    pub fn patch_active_settings(&self, patch: serde_json::Value) -> Result<LexelProfile, DbError> {
        let active = self.active_profile()?;
        let mut current_val = serde_json::to_value(&active.settings)?;
        merge_json_objects(&mut current_val, patch, None);
        let merged: UnifiedSettings = serde_json::from_value(current_val)?;
        self.update_active_settings(&merged)
    }

    /// Set the active profile's main AI model (`0.5b`, `1.5b`, `lexel-0.5b`, `lexel-1.5b`, or custom name).
    pub fn set_main_model(&self, model_spec: &str) -> Result<LexelProfile, DbError> {
        let mut active = self.active_profile()?;
        let normalized = model_spec.trim().to_ascii_lowercase();
        match normalized.as_str() {
            "0.5b" | "lexel-0.5b" | "qwen2.5:0.5b" | "lite" => {
                active.settings.main_model_tier = MainModelTier::Lexel05B;
                active.settings.custom_model = "qwen2.5:0.5b".to_owned();
            }
            "1.5b" | "lexel-1.5b" | "qwen2.5:1.5b" | "standard" => {
                active.settings.main_model_tier = MainModelTier::Lexel15B;
                active.settings.custom_model = "qwen2.5:1.5b".to_owned();
            }
            _ => {
                active.settings.main_model_tier = MainModelTier::Custom;
                active.settings.custom_model = model_spec.trim().to_owned();
            }
        }
        self.update_active_settings(&active.settings)
    }

    /// Toggle local AI on/off for the active profile.
    pub fn set_ai_enabled(&self, enabled: bool) -> Result<LexelProfile, DbError> {
        let mut active = self.active_profile()?;
        active.settings.ai_enabled = enabled;
        self.update_active_settings(&active.settings)
    }

    /// Save an accepted or edited rewrite into SQLite + FTS5 voice memory for the active profile.
    pub fn save_voice_example(
        &self,
        surface_id: &str,
        subcontext: Option<&str>,
        original: &str,
        rewritten: &str,
        action: &str,
    ) -> Result<VoiceExample, DbError> {
        let active = self.active_profile()?;
        let id = Uuid::new_v4().to_string();
        let created_at = now_millis();
        let sub = subcontext
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);

        self.conn.execute(
            "INSERT INTO voice_examples (id, profile_id, surface_id, subcontext, original, rewritten, action, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, active.id, surface_id, sub, original, rewritten, action, created_at],
        )?;
        self.conn.execute(
            "INSERT INTO voice_examples_fts (id, profile_id, surface_id, original, rewritten)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, active.id, surface_id, original, rewritten],
        )?;

        Ok(VoiceExample {
            id,
            profile_id: active.id,
            surface_id: surface_id.to_owned(),
            subcontext: sub,
            original: original.to_owned(),
            rewritten: rewritten.to_owned(),
            action: action.to_owned(),
            created_at,
        })
    }

    /// List stored voice examples for the active profile (optionally filtered by surface).
    pub fn list_voice_examples(
        &self,
        surface_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<VoiceExample>, DbError> {
        let active = self.active_profile()?;
        let cap = limit.clamp(1, 500) as i64;
        let mut out = Vec::new();
        if let Some(surface) = surface_id {
            let mut stmt = self.conn.prepare(
                "SELECT id, profile_id, surface_id, subcontext, original, rewritten, action, created_at
                 FROM voice_examples
                 WHERE profile_id = ?1 AND surface_id = ?2
                 ORDER BY created_at DESC
                 LIMIT ?3",
            )?;
            let rows = stmt.query_map(params![active.id, surface, cap], Self::parse_voice_row)?;
            for item in rows {
                out.push(item?);
            }
        } else {
            let mut stmt = self.conn.prepare(
                "SELECT id, profile_id, surface_id, subcontext, original, rewritten, action, created_at
                 FROM voice_examples
                 WHERE profile_id = ?1
                 ORDER BY created_at DESC
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![active.id, cap], Self::parse_voice_row)?;
            for item in rows {
                out.push(item?);
            }
        }
        Ok(out)
    }

    /// Retrieve top few-shot voice examples for a surface using SQLite FTS5 ranking,
    /// falling back to recent examples on that surface when FTS finds no token overlap.
    pub fn search_voice_examples(
        &self,
        surface_id: &str,
        query_text: &str,
        limit: usize,
    ) -> Result<Vec<VoiceExample>, DbError> {
        let active = self.active_profile()?;
        let cap = limit.clamp(1, 10) as i64;
        let fts_terms: Vec<String> = query_text
            .split(|c: char| !c.is_ascii_alphanumeric())
            .filter(|w| w.len() >= 3)
            .take(8)
            .map(|w| format!("\"{}\"", w.to_ascii_lowercase()))
            .collect();

        if !fts_terms.is_empty() {
            let match_expr = fts_terms.join(" OR ");
            let mut stmt = self.conn.prepare(
                "SELECT v.id, v.profile_id, v.surface_id, v.subcontext, v.original, v.rewritten, v.action, v.created_at
                 FROM voice_examples_fts f
                 JOIN voice_examples v ON v.id = f.id
                 WHERE voice_examples_fts MATCH ?1
                   AND v.profile_id = ?2
                   AND (v.surface_id = ?3 OR v.surface_id = 'general')
                 ORDER BY CASE WHEN v.surface_id = ?3 THEN 0 ELSE 1 END, bm25(voice_examples_fts), v.created_at DESC
                 LIMIT ?4",
            )?;
            let rows = stmt.query_map(
                params![match_expr, active.id, surface_id, cap],
                Self::parse_voice_row,
            )?;
            let mut out = Vec::new();
            for item in rows {
                out.push(item?);
            }
            if !out.is_empty() {
                return Ok(out);
            }
        }

        self.list_voice_examples(Some(surface_id), limit)
    }

    /// Delete one voice example by ID from the active profile.
    pub fn delete_voice_example(&self, id: &str) -> Result<bool, DbError> {
        let active = self.active_profile()?;
        self.conn.execute(
            "DELETE FROM voice_examples_fts WHERE id = ?1 AND profile_id = ?2",
            params![id, active.id],
        )?;
        let changed = self.conn.execute(
            "DELETE FROM voice_examples WHERE id = ?1 AND profile_id = ?2",
            params![id, active.id],
        )?;
        Ok(changed > 0)
    }

    /// Record numeric-only local writing metrics for the active profile (never logs raw text).
    pub fn record_writing_event(
        &self,
        surface_id: &str,
        words_checked: usize,
        grammar_hits: usize,
        slop_hits: usize,
        secret_blocks: usize,
        fixes_applied: usize,
    ) -> Result<(), DbError> {
        let active = self.active_profile()?;
        let id = Uuid::new_v4().to_string();
        let now = now_millis();
        self.conn.execute(
            "INSERT INTO writing_events
             (id, profile_id, surface_id, words_checked, grammar_hits, slop_hits, secret_blocks, fixes_applied, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                id,
                active.id,
                surface_id,
                words_checked as i64,
                grammar_hits as i64,
                slop_hits as i64,
                secret_blocks as i64,
                fixes_applied as i64,
                now
            ],
        )?;
        Ok(())
    }

    /// Aggregate local writing statistics for the active profile.
    pub fn writing_stats_summary(&self) -> Result<WritingStatsSummary, DbError> {
        let active = self.active_profile()?;
        let (checks, words, grammar, slop, secrets, fixes): (i64, i64, i64, i64, i64, i64) =
            self.conn.query_row(
                "SELECT COUNT(*),
                        COALESCE(SUM(words_checked), 0),
                        COALESCE(SUM(grammar_hits), 0),
                        COALESCE(SUM(slop_hits), 0),
                        COALESCE(SUM(secret_blocks), 0),
                        COALESCE(SUM(fixes_applied), 0)
                 FROM writing_events
                 WHERE profile_id = ?1",
                params![active.id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )?;

        let mut stmt = self.conn.prepare(
            "SELECT surface_id, COUNT(*) as cnt
             FROM writing_events
             WHERE profile_id = ?1
             GROUP BY surface_id
             ORDER BY cnt DESC
             LIMIT 6",
        )?;
        let rows = stmt.query_map(params![active.id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
        })?;
        let mut top_surfaces = Vec::new();
        for row in rows {
            top_surfaces.push(row?);
        }

        Ok(WritingStatsSummary {
            total_checks: checks.max(0) as usize,
            total_words_checked: words.max(0) as usize,
            total_grammar_hits: grammar.max(0) as usize,
            total_slop_hits: slop.max(0) as usize,
            total_secret_blocks: secrets.max(0) as usize,
            total_fixes_applied: fixes.max(0) as usize,
            top_surfaces,
        })
    }

    /// Save an opt-in local scratchpad draft snapshot for the active profile (retains latest 50).
    pub fn save_draft_snapshot(
        &self,
        surface_id: &str,
        title: Option<&str>,
        content: &str,
    ) -> Result<DraftSnapshot, DbError> {
        let active = self.active_profile()?;
        let id = Uuid::new_v4().to_string();
        let now = now_millis();
        let word_count = content.split_whitespace().count();
        let resolved_title = title
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                let first_line = content
                    .lines()
                    .find(|l| !l.trim().is_empty())
                    .unwrap_or("Untitled draft")
                    .trim();
                let clipped: String = first_line.chars().take(48).collect();
                if first_line.chars().count() > 48 {
                    format!("{clipped}...")
                } else {
                    clipped
                }
            });

        self.conn.execute(
            "INSERT INTO draft_snapshots (id, profile_id, surface_id, title, content, word_count, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                active.id,
                surface_id,
                resolved_title,
                content,
                word_count as i64,
                now
            ],
        )?;

        self.conn.execute(
            "DELETE FROM draft_snapshots
             WHERE profile_id = ?1
               AND id NOT IN (
                   SELECT id FROM draft_snapshots
                   WHERE profile_id = ?1
                   ORDER BY created_at DESC
                   LIMIT 50
               )",
            params![active.id],
        )?;

        Ok(DraftSnapshot {
            id,
            profile_id: active.id,
            surface_id: surface_id.to_owned(),
            title: resolved_title,
            content: content.to_owned(),
            word_count,
            created_at: now,
        })
    }

    /// List saved draft snapshots for the active profile, newest first.
    pub fn list_draft_snapshots(&self, limit: usize) -> Result<Vec<DraftSnapshot>, DbError> {
        let active = self.active_profile()?;
        let mut stmt = self.conn.prepare(
            "SELECT id, profile_id, surface_id, title, content, word_count, created_at
             FROM draft_snapshots
             WHERE profile_id = ?1
             ORDER BY created_at DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![active.id, limit as i64], |r| {
            Ok(DraftSnapshot {
                id: r.get(0)?,
                profile_id: r.get(1)?,
                surface_id: r.get(2)?,
                title: r.get(3)?,
                content: r.get(4)?,
                word_count: r.get::<_, i64>(5)?.max(0) as usize,
                created_at: r.get(6)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Delete one draft snapshot by ID for the active profile.
    pub fn delete_draft_snapshot(&self, id: &str) -> Result<bool, DbError> {
        let active = self.active_profile()?;
        let changed = self.conn.execute(
            "DELETE FROM draft_snapshots WHERE id = ?1 AND profile_id = ?2",
            params![id, active.id],
        )?;
        Ok(changed > 0)
    }

    /// Export all profiles and voice memory as a portable JSON backup.
    pub fn export_backup(&self) -> Result<DatabaseBackup, DbError> {
        let profiles = self.list_profiles()?;
        let mut stmt = self.conn.prepare(
            "SELECT id, profile_id, surface_id, subcontext, original, rewritten, action, created_at
             FROM voice_examples ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([], Self::parse_voice_row)?;
        let mut voice_examples = Vec::new();
        for item in rows {
            voice_examples.push(item?);
        }
        Ok(DatabaseBackup {
            version: 1,
            exported_at: now_millis(),
            profiles,
            voice_examples,
        })
    }

    /// Restore profiles and voice memory from an exported JSON backup atomically.
    pub fn import_backup(&self, backup: DatabaseBackup) -> Result<LexelProfile, DbError> {
        if backup.profiles.is_empty() {
            return Err(DbError::InvalidBackup(
                "backup contains no profiles".to_owned(),
            ));
        }

        // Run inside an explicit SAVEPOINT so a malformed backup never wipes existing user data.
        self.conn.execute_batch("SAVEPOINT import_backup")?;
        let outcome = (|| -> Result<LexelProfile, DbError> {
            self.conn.execute_batch(
                "DELETE FROM voice_examples_fts;
                 DELETE FROM voice_examples;
                 DELETE FROM writing_events;
                 DELETE FROM writing_pattern_hits;
                 DELETE FROM crutch_word_bans;
                 DELETE FROM draft_snapshots;
                 DELETE FROM sub_contexts;
                 DELETE FROM profiles;",
            )?;

            let mut any_active = false;
            for p in &backup.profiles {
                if p.is_active {
                    any_active = true;
                }
                let json = serde_json::to_string(&p.settings)?;
                self.conn.execute(
                    "INSERT INTO profiles (id, name, is_active, settings_json, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        p.id,
                        p.name,
                        if p.is_active { 1 } else { 0 },
                        json,
                        p.created_at,
                        p.updated_at
                    ],
                )?;
            }
            if !any_active {
                self.ensure_default_profile()?;
            }

            for ex in &backup.voice_examples {
                self.conn.execute(
                    "INSERT INTO voice_examples (id, profile_id, surface_id, subcontext, original, rewritten, action, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        ex.id,
                        ex.profile_id,
                        ex.surface_id,
                        ex.subcontext,
                        ex.original,
                        ex.rewritten,
                        ex.action,
                        ex.created_at
                    ],
                )?;
                self.conn.execute(
                    "INSERT INTO voice_examples_fts (id, profile_id, surface_id, original, rewritten)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        ex.id,
                        ex.profile_id,
                        ex.surface_id,
                        ex.original,
                        ex.rewritten
                    ],
                )?;
            }
            self.active_profile()
        })();

        match outcome {
            Ok(profile) => {
                self.conn.execute_batch("RELEASE SAVEPOINT import_backup")?;
                Ok(profile)
            }
            Err(err) => {
                let _ = self.conn.execute_batch(
                    "ROLLBACK TO SAVEPOINT import_backup; RELEASE SAVEPOINT import_backup",
                );
                Err(err)
            }
        }
    }

    /// Purge all stored user voice examples, analytics, drafts, and reset profiles back to a clean default.
    pub fn purge_all(&self) -> Result<LexelProfile, DbError> {
        self.conn.execute_batch(
            "DELETE FROM voice_examples_fts;
             DELETE FROM voice_examples;
             DELETE FROM writing_events;
             DELETE FROM writing_pattern_hits;
             DELETE FROM crutch_word_bans;
             DELETE FROM draft_snapshots;
             DELETE FROM sub_contexts;
             DELETE FROM profiles;",
        )?;
        self.ensure_default_profile()?;
        self.active_profile()
    }

    /// Seed local `voice_examples` from pasted prose, imported files, or git commits and return style stats.
    pub fn import_voice_samples(
        &self,
        source_kind: &str,
        samples: &[VoiceImportSample],
    ) -> Result<VoiceImportReport, DbError> {
        let active = self.active_profile()?;
        let mut existing: HashSet<String> = HashSet::new();
        {
            let mut stmt = self
                .conn
                .prepare("SELECT rewritten FROM voice_examples WHERE profile_id = ?1")?;
            let rows = stmt.query_map(params![active.id], |r| r.get::<_, String>(0))?;
            for row in rows {
                existing.insert(normalize_dedup_key(&row?));
            }
        }

        let action = format!("imported:{source_kind}");
        let mut imported_count = 0usize;
        let mut skipped_count = 0usize;

        for sample in samples {
            let cleaned = sample.text.trim();
            let char_len = cleaned.chars().count();
            if !(15..=4000).contains(&char_len) || !scan_secrets(cleaned).is_empty() {
                skipped_count += 1;
                continue;
            }
            let dedup_key = normalize_dedup_key(cleaned);
            if existing.contains(&dedup_key) {
                skipped_count += 1;
                continue;
            }

            let surface_id = if sample.surface_id.trim().is_empty() {
                "general"
            } else {
                sample.surface_id.trim()
            };
            let original = sample
                .original
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| synthesize_baseline_draft(cleaned, surface_id));

            self.save_voice_example(surface_id, Some(source_kind), &original, cleaned, &action)?;
            existing.insert(dedup_key);
            imported_count += 1;
        }

        let style_stats = self.voice_style_stats(None)?;
        Ok(VoiceImportReport {
            imported_count,
            skipped_count,
            source_kind: source_kind.to_owned(),
            style_stats,
        })
    }

    /// Import recent non-merge commit messages from a local Git repository into `voice_examples`.
    pub fn import_voice_from_git_log(
        &self,
        repo_path: &Path,
        author: Option<&str>,
        limit: usize,
    ) -> Result<VoiceImportReport, DbError> {
        let cap = limit.clamp(1, 500);
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(repo_path).args([
            "log",
            "--no-merges",
            "-n",
            &cap.to_string(),
            "--pretty=format:%s%n%b%x1e",
        ]);
        if let Some(a) = author.map(str::trim).filter(|s| !s.is_empty()) {
            cmd.arg(format!("--author={a}"));
        }

        let output = cmd
            .output()
            .map_err(|e| DbError::Import(format!("failed to invoke git log: {e}")))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            return Err(DbError::Import(if stderr.is_empty() {
                "git log exited with non-zero status".to_owned()
            } else {
                stderr
            }));
        }

        let raw = String::from_utf8_lossy(&output.stdout);
        let mut samples = Vec::new();
        for record in raw.split('\u{1e}') {
            let trimmed = record.trim();
            if trimmed.is_empty()
                || trimmed.starts_with("Merge ")
                || trimmed.starts_with("Revert \"")
            {
                continue;
            }
            let cleaned: String = trimmed
                .lines()
                .filter(|line| {
                    let l = line.trim_start();
                    !l.starts_with("Signed-off-by:")
                        && !l.starts_with("Co-authored-by:")
                        && !l.starts_with("Change-Id:")
                })
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_owned();
            if !cleaned.is_empty() {
                samples.push(VoiceImportSample {
                    surface_id: "ide_git_commit".to_owned(),
                    text: cleaned,
                    original: None,
                });
            }
        }

        self.import_voice_samples("git_log", &samples)
    }

    /// Import human writing paragraphs from local text or markdown files into `voice_examples`.
    pub fn import_voice_from_files(
        &self,
        paths: &[PathBuf],
        surface_id: &str,
    ) -> Result<VoiceImportReport, DbError> {
        let mut samples = Vec::new();
        for path in paths {
            let raw = std::fs::read_to_string(path)
                .map_err(|e| DbError::Import(format!("failed to read {}: {e}", path.display())))?;
            let effective_surface = if surface_id.trim().is_empty() || surface_id == "auto" {
                match path.extension().and_then(|e| e.to_str()) {
                    Some("md" | "mdx" | "rst" | "adoc") => "docs_markdown",
                    _ => "general",
                }
            } else {
                surface_id
            };
            for para in extract_prose_paragraphs(&raw) {
                samples.push(VoiceImportSample {
                    surface_id: effective_surface.to_owned(),
                    text: para,
                    original: None,
                });
            }
        }
        self.import_voice_samples("files", &samples)
    }

    /// Compute local voice fingerprint statistics from stored `voice_examples`.
    pub fn voice_style_stats(&self, surface_id: Option<&str>) -> Result<VoiceStyleStats, DbError> {
        let examples = self.list_voice_examples(surface_id, 500)?;
        if examples.is_empty() {
            return Ok(VoiceStyleStats::default());
        }

        let scanner = SlopScanner::load_embedded()?;
        let mut total_words = 0usize;
        let mut total_sentences = 0usize;
        let mut total_word_chars = 0usize;
        let mut word_token_count = 0usize;
        let mut em_dash_free = 0usize;
        let mut total_slop_hits = 0usize;
        let mut surface_counts: BTreeMap<String, usize> = BTreeMap::new();
        let mut opener_counts: BTreeMap<String, usize> = BTreeMap::new();

        for ex in &examples {
            *surface_counts.entry(ex.surface_id.clone()).or_insert(0) += 1;
            let text = ex.rewritten.trim();
            let rd = analyze_readability(text);
            total_words += rd.words;
            total_sentences += rd.sentences.max(1);
            for w in text.split_whitespace() {
                let letters = w.chars().filter(|c| c.is_alphabetic()).count();
                if letters > 0 {
                    total_word_chars += letters;
                    word_token_count += 1;
                }
            }
            if !text.contains('—') && !text.contains(" -- ") {
                em_dash_free += 1;
            }
            total_slop_hits += scanner.scan(text, false).len();
            if let Some(first_two) = first_two_words(text) {
                *opener_counts.entry(first_two).or_insert(0) += 1;
            }
        }

        let total = examples.len();
        let avg_sentence_words = round2(total_words as f64 / total_sentences.max(1) as f64);
        let avg_word_length = round2(total_word_chars as f64 / word_token_count.max(1) as f64);
        let em_dash_free_rate = round2(em_dash_free as f64 / total as f64);

        let slop_per_example = total_slop_hits as f64 / total as f64;
        let length_penalty = ((avg_sentence_words - 16.0).max(0.0) * 1.5).min(30.0);
        let slop_penalty = (slop_per_example * 25.0).min(40.0);
        let directness_score = (100.0 - length_penalty - slop_penalty).clamp(0.0, 100.0) as u8;

        let mut top_surfaces: Vec<(String, usize)> = surface_counts.into_iter().collect();
        top_surfaces.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        top_surfaces.truncate(6);

        let mut openers: Vec<(String, usize)> = opener_counts.into_iter().collect();
        openers.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let sample_openers = openers.into_iter().take(5).map(|(k, _)| k).collect();

        Ok(VoiceStyleStats {
            total_examples: total,
            avg_sentence_words,
            avg_word_length,
            directness_score,
            em_dash_free_rate,
            top_surfaces,
            sample_openers,
        })
    }

    /// Export edited/rejected voice examples as PII-scrubbed SimPO/DPO preference pairs.
    pub fn export_simpo_pairs(
        &self,
        surface_id: Option<&str>,
        include_accepted: bool,
        limit: usize,
    ) -> Result<Vec<SimpoExportPair>, DbError> {
        let active = self.active_profile()?;
        let examples = self.list_voice_examples(surface_id, limit.clamp(1, 500))?;
        let mut pairs = Vec::new();

        for ex in examples {
            let action_lower = ex.action.trim().to_ascii_lowercase();
            let is_preference_action = matches!(
                action_lower.as_str(),
                "edited" | "rejected" | "edited_hunk" | "partial_accept"
            );
            if !is_preference_action && !include_accepted {
                continue;
            }
            if action_lower.starts_with("imported:") && !include_accepted {
                continue;
            }

            let (raw_chosen, raw_rejected, raw_source, perturbation_type) =
                if action_lower == "rejected" {
                    (
                        ex.original.as_str(),
                        ex.rewritten.as_str(),
                        ex.original.as_str(),
                        "user_rejection",
                    )
                } else {
                    (
                        ex.rewritten.as_str(),
                        ex.original.as_str(),
                        ex.original.as_str(),
                        "user_edit",
                    )
                };

            let chosen = scrub_pii_for_export(raw_chosen);
            let rejected = scrub_pii_for_export(raw_rejected);
            let source = scrub_pii_for_export(raw_source);
            if chosen.is_empty() || rejected.is_empty() || chosen == rejected {
                continue;
            }

            let mut messages = build_rewrite_messages_with_surfaces(
                &source,
                AiTaskId::RewriteSurface,
                &ex.surface_id,
                ex.subcontext.as_deref(),
                None,
                &[],
                &active.settings.custom_surfaces,
            )?;
            for msg in &mut messages {
                msg.content = scrub_pii_for_export(&msg.content);
            }
            let prompt = messages
                .iter()
                .map(|m| m.content.as_str())
                .collect::<Vec<_>>()
                .join("\n\n");

            // Fail closed: drop the row if any secret pattern still survives after scrubbing.
            if !scan_secrets(&source).is_empty()
                || !scan_secrets(&chosen).is_empty()
                || !scan_secrets(&rejected).is_empty()
                || !scan_secrets(&prompt).is_empty()
            {
                continue;
            }

            let perturbed_spans = compute_perturbed_spans(&chosen, &rejected, perturbation_type);

            pairs.push(SimpoExportPair {
                pair_id: format!("user_pref_{}", ex.id),
                example_id: ex.id,
                surface_id: ex.surface_id,
                task: "rewrite_surface".to_owned(),
                subcontext: ex.subcontext,
                source,
                prompt,
                chosen,
                rejected,
                perturbation_type: perturbation_type.to_owned(),
                perturbed_spans,
                rejected_token_mask: Vec::new(),
                origin: "lexel_user_feedback".to_owned(),
                messages,
                created_at: ex.created_at,
            });
        }

        Ok(pairs)
    }

    /// List banned personal crutch words for the active profile.
    pub fn list_crutch_word_bans(&self) -> Result<Vec<String>, DbError> {
        let active = self.active_profile()?;
        let mut stmt = self.conn.prepare(
            "SELECT word FROM crutch_word_bans
             WHERE profile_id = ?1
             ORDER BY word ASC",
        )?;
        let rows = stmt.query_map(params![active.id], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Replace the active profile's banned crutch words and sync them with `custom_slop_terms`.
    pub fn set_crutch_word_bans(&self, words: &[String]) -> Result<Vec<String>, DbError> {
        let active = self.active_profile()?;
        let previous = self.list_crutch_word_bans()?;
        let now = now_millis();

        let mut normalized: Vec<String> = Vec::new();
        for raw in words {
            let clean = raw.trim().to_ascii_lowercase();
            if !clean.is_empty() && !normalized.contains(&clean) {
                normalized.push(clean);
            }
        }
        normalized.sort();

        self.conn.execute(
            "DELETE FROM crutch_word_bans WHERE profile_id = ?1",
            params![active.id],
        )?;
        for word in &normalized {
            self.conn.execute(
                "INSERT INTO crutch_word_bans (profile_id, word, created_at)
                 VALUES (?1, ?2, ?3)",
                params![active.id, word, now],
            )?;
        }

        self.sync_crutch_bans_to_custom_slop(&previous, &normalized)?;
        Ok(normalized)
    }

    /// Ban or unban a single personal crutch word for the active profile.
    pub fn toggle_crutch_word_ban(&self, word: &str, banned: bool) -> Result<Vec<String>, DbError> {
        let clean = word.trim().to_ascii_lowercase();
        let mut current = self.list_crutch_word_bans()?;
        if clean.is_empty() {
            return Ok(current);
        }
        if banned {
            if !current.contains(&clean) {
                current.push(clean);
            }
        } else {
            current.retain(|w| w != &clean);
        }
        self.set_crutch_word_bans(&current)
    }

    fn sync_crutch_bans_to_custom_slop(
        &self,
        previous: &[String],
        current: &[String],
    ) -> Result<(), DbError> {
        let mut active = self.active_profile()?;
        for old in previous {
            if !current.contains(old) {
                active.settings.custom_slop_terms.retain(|entry| {
                    let term = entry.split("=>").next().unwrap_or(entry).trim();
                    !term.eq_ignore_ascii_case(old)
                });
            }
        }
        for word in current {
            let already = active.settings.custom_slop_terms.iter().any(|entry| {
                let term = entry.split("=>").next().unwrap_or(entry).trim();
                term.eq_ignore_ascii_case(word)
            });
            if !already {
                active.settings.custom_slop_terms.push(word.clone());
            }
        }
        self.update_active_settings(&active.settings)?;
        Ok(())
    }

    /// Record aggregate pattern hit counts (slop or crutch word) without storing raw user text.
    pub fn record_pattern_hits(&self, kind: &str, terms: &[String]) -> Result<(), DbError> {
        let active = self.active_profile()?;
        let now = now_millis();
        for term in terms {
            let clean = term.trim().to_ascii_lowercase();
            if clean.is_empty() {
                continue;
            }
            self.conn.execute(
                "INSERT INTO writing_pattern_hits (profile_id, kind, term, hit_count, updated_at)
                 VALUES (?1, ?2, ?3, 1, ?4)
                 ON CONFLICT(profile_id, kind, term)
                 DO UPDATE SET hit_count = hit_count + 1, updated_at = excluded.updated_at",
                params![active.id, kind, clean, now],
            )?;
        }
        Ok(())
    }

    /// Compute Private Weekly Writing Insights strictly from local SQLite tables.
    pub fn weekly_insights(&self, days: usize) -> Result<WeeklyInsightsReport, DbError> {
        let active = self.active_profile()?;
        let period_days = days.clamp(1, 90);
        let now = now_millis();
        let day_ms = 86_400_000_i64;
        let window_start = now - (period_days as i64) * day_ms;
        let prev_window_start = window_start - (period_days as i64) * day_ms;

        let (checks_cur, words_cur, grammar_cur, slop_cur, secrets_cur, fixes_cur) =
            self.aggregate_events_window(&active.id, window_start, now + 1)?;
        let (_checks_prev, words_prev, grammar_prev, slop_prev, _secrets_prev, _fixes_prev) =
            self.aggregate_events_window(&active.id, prev_window_start, window_start)?;

        let clarity_score = compute_clarity_score(words_cur, grammar_cur, slop_cur);
        let conciseness_score = compute_conciseness_score(words_cur, slop_cur, fixes_cur);

        let clarity_delta = if words_prev > 0 {
            clarity_score as i16 - compute_clarity_score(words_prev, grammar_prev, slop_prev) as i16
        } else {
            0
        };
        let conciseness_delta = if words_prev > 0 {
            conciseness_score as i16 - compute_conciseness_score(words_prev, slop_prev, 0) as i16
        } else {
            0
        };

        let mut bucket_map: BTreeMap<String, DailyWritingBucket> = BTreeMap::new();
        {
            let mut stmt = self.conn.prepare(
                "SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') as day_utc,
                        COUNT(*),
                        COALESCE(SUM(words_checked), 0),
                        COALESCE(SUM(slop_hits), 0),
                        COALESCE(SUM(grammar_hits), 0),
                        COALESCE(SUM(fixes_applied), 0)
                 FROM writing_events
                 WHERE profile_id = ?1 AND created_at >= ?2
                 GROUP BY day_utc
                 ORDER BY day_utc ASC",
            )?;
            let rows = stmt.query_map(params![active.id, window_start], |r| {
                Ok(DailyWritingBucket {
                    day_utc: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    checks: r.get::<_, i64>(1)?.max(0) as usize,
                    words: r.get::<_, i64>(2)?.max(0) as usize,
                    slop_hits: r.get::<_, i64>(3)?.max(0) as usize,
                    grammar_hits: r.get::<_, i64>(4)?.max(0) as usize,
                    fixes_applied: r.get::<_, i64>(5)?.max(0) as usize,
                })
            })?;
            for row in rows {
                let bucket = row?;
                if !bucket.day_utc.is_empty() {
                    bucket_map.insert(bucket.day_utc.clone(), bucket);
                }
            }
        }
        let daily_buckets: Vec<DailyWritingBucket> = bucket_map.into_values().collect();

        let banned_crutch_words = self.list_crutch_word_bans()?;
        let mut crutch_counts: BTreeMap<String, usize> = BTreeMap::new();
        let mut slop_counts: BTreeMap<String, usize> = BTreeMap::new();

        {
            let mut stmt = self.conn.prepare(
                "SELECT kind, term, hit_count
                 FROM writing_pattern_hits
                 WHERE profile_id = ?1",
            )?;
            let rows = stmt.query_map(params![active.id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?.max(0) as usize,
                ))
            })?;
            for row in rows {
                let (kind, term, count) = row?;
                if kind == "crutch" {
                    *crutch_counts.entry(term).or_insert(0) += count;
                } else if kind == "slop" {
                    *slop_counts.entry(term).or_insert(0) += count;
                }
            }
        }

        // Supplement with local voice_examples and draft_snapshots scans so users see real crutch words immediately.
        let scanner = SlopScanner::load_embedded()?;
        let voice_examples = self.list_voice_examples(None, 200)?;
        let voice_examples_count = voice_examples.len();
        for ex in &voice_examples {
            count_crutch_words_in_text(&ex.original, &banned_crutch_words, &mut crutch_counts);
            for hit in scanner.scan(&ex.original, false) {
                let label = if hit.is_em_dash {
                    "em_dash".to_owned()
                } else {
                    hit.term.to_ascii_lowercase()
                };
                *slop_counts.entry(label).or_insert(0) += 1;
            }
        }
        for draft in self.list_draft_snapshots(50)? {
            count_crutch_words_in_text(&draft.content, &banned_crutch_words, &mut crutch_counts);
            for hit in scanner.scan(&draft.content, false) {
                let label = if hit.is_em_dash {
                    "em_dash".to_owned()
                } else {
                    hit.term.to_ascii_lowercase()
                };
                *slop_counts.entry(label).or_insert(0) += 1;
            }
        }

        let mut top_crutch_words: Vec<CrutchWordStat> = crutch_counts
            .into_iter()
            .filter(|(_, count)| *count > 0)
            .map(|(word, count)| CrutchWordStat {
                banned: banned_crutch_words.iter().any(|b| b == &word),
                word,
                count,
            })
            .collect();
        top_crutch_words.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.word.cmp(&b.word)));
        top_crutch_words.truncate(8);

        let mut top_slop_patterns: Vec<(String, usize)> = slop_counts.into_iter().collect();
        top_slop_patterns.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        top_slop_patterns.truncate(8);

        Ok(WeeklyInsightsReport {
            period_days,
            checks_in_period: checks_cur,
            words_in_period: words_cur,
            slop_caught_in_period: slop_cur,
            grammar_hits_in_period: grammar_cur,
            secrets_blocked_in_period: secrets_cur,
            fixes_applied_in_period: fixes_cur,
            clarity_score,
            clarity_delta,
            conciseness_score,
            conciseness_delta,
            top_crutch_words,
            banned_crutch_words,
            top_slop_patterns,
            daily_buckets,
            voice_examples_count,
        })
    }

    fn aggregate_events_window(
        &self,
        profile_id: &str,
        start_ms: i64,
        end_ms: i64,
    ) -> Result<(usize, usize, usize, usize, usize, usize), DbError> {
        let (checks, words, grammar, slop, secrets, fixes): (i64, i64, i64, i64, i64, i64) =
            self.conn.query_row(
                "SELECT COUNT(*),
                        COALESCE(SUM(words_checked), 0),
                        COALESCE(SUM(grammar_hits), 0),
                        COALESCE(SUM(slop_hits), 0),
                        COALESCE(SUM(secret_blocks), 0),
                        COALESCE(SUM(fixes_applied), 0)
                 FROM writing_events
                 WHERE profile_id = ?1 AND created_at >= ?2 AND created_at < ?3",
                params![profile_id, start_ms, end_ms],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )?;
        Ok((
            checks.max(0) as usize,
            words.max(0) as usize,
            grammar.max(0) as usize,
            slop.max(0) as usize,
            secrets.max(0) as usize,
            fixes.max(0) as usize,
        ))
    }

    fn parse_voice_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<VoiceExample> {
        Ok(VoiceExample {
            id: row.get(0)?,
            profile_id: row.get(1)?,
            surface_id: row.get(2)?,
            subcontext: row.get(3)?,
            original: row.get(4)?,
            rewritten: row.get(5)?,
            action: row.get(6)?,
            created_at: row.get(7)?,
        })
    }
}

fn merge_json_objects(
    base: &mut serde_json::Value,
    patch: serde_json::Value,
    parent_key: Option<&str>,
) {
    match (base, patch) {
        (serde_json::Value::Object(base_map), serde_json::Value::Object(patch_map)) => {
            for (k, v) in patch_map {
                if v.is_null() && matches!(parent_key, Some("domainStatuses" | "surfaceOverrides"))
                {
                    base_map.remove(&k);
                    continue;
                }
                match base_map.get_mut(&k) {
                    Some(existing) if existing.is_object() && v.is_object() => {
                        merge_json_objects(existing, v, Some(k.as_str()));
                    }
                    _ => {
                        base_map.insert(k, v);
                    }
                }
            }
        }
        (base_slot, new_val) => *base_slot = new_val,
    }
}

const DEFAULT_CRUTCH_WORDS: &[&str] = &[
    "just",
    "actually",
    "basically",
    "honestly",
    "literally",
    "really",
    "very",
    "simply",
    "obviously",
    "clearly",
    "definitely",
    "probably",
    "perhaps",
    "kind of",
    "sort of",
];

/// Scrub secrets, email addresses, phone numbers, and IPv4 addresses before exporting preference pairs.
pub fn scrub_pii_for_export(text: &str) -> String {
    let mut out = text.to_owned();
    let mut matches = scan_secrets(&out);
    matches.sort_by_key(|a| std::cmp::Reverse(a.start));
    for m in matches {
        if m.end <= out.len() && m.start <= m.end {
            out.replace_range(
                m.start..m.end,
                &format!("[REDACTED_{}]", m.kind.to_ascii_uppercase()),
            );
        }
    }
    if let Ok(email_re) = Regex::new(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b") {
        out = email_re.replace_all(&out, "[REDACTED_EMAIL]").into_owned();
    }
    if let Ok(phone_re) = Regex::new(
        r"(?x)(?:^|[\s(])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}\b",
    ) {
        out = phone_re.replace_all(&out, " [REDACTED_PHONE]").into_owned();
    }
    if let Ok(ip_re) = Regex::new(r"\b(?:\d{1,3}\.){3}\d{1,3}\b") {
        out = ip_re.replace_all(&out, "[REDACTED_IP]").into_owned();
    }
    out.trim().to_owned()
}

fn normalize_dedup_key(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

fn synthesize_baseline_draft(clean_sample: &str, surface_id: &str) -> String {
    if surface_id == "ide_git_commit" {
        format!("Updated changes in order to seamlessly apply: {clean_sample}")
    } else {
        format!("It is important to note that {clean_sample}")
    }
}

fn extract_prose_paragraphs(raw: &str) -> Vec<String> {
    let mut paragraphs = Vec::new();
    let mut current = Vec::new();
    let mut in_fence = false;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            if !current.is_empty() {
                paragraphs.push(current.join(" "));
                current.clear();
            }
            continue;
        }
        if in_fence {
            continue;
        }
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('|') {
            if !current.is_empty() {
                paragraphs.push(current.join(" "));
                current.clear();
            }
            continue;
        }
        current.push(trimmed.to_owned());
    }
    if !current.is_empty() {
        paragraphs.push(current.join(" "));
    }

    paragraphs
        .into_iter()
        .map(|p| p.trim().to_owned())
        .filter(|p| {
            let chars = p.chars().count();
            let words = p.split_whitespace().count();
            (20..=1500).contains(&chars) && words >= 5
        })
        .collect()
}

fn first_two_words(text: &str) -> Option<String> {
    let words: Vec<&str> = text
        .split_whitespace()
        .take(2)
        .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()))
        .filter(|w| !w.is_empty())
        .collect();
    if words.is_empty() {
        None
    } else {
        Some(words.join(" ").to_ascii_lowercase())
    }
}

fn count_crutch_words_in_text(
    text: &str,
    extra_banned: &[String],
    counts: &mut BTreeMap<String, usize>,
) {
    let lower = text.to_ascii_lowercase();
    let mut candidates: Vec<&str> = DEFAULT_CRUTCH_WORDS.to_vec();
    for extra in extra_banned {
        if !candidates.iter().any(|c| c.eq_ignore_ascii_case(extra)) {
            candidates.push(extra.as_str());
        }
    }
    for phrase in candidates {
        let needle = phrase.trim();
        if needle.is_empty() {
            continue;
        }
        if needle.contains(' ') {
            let hit_count = lower.matches(needle).count();
            if hit_count > 0 {
                *counts.entry(needle.to_owned()).or_insert(0) += hit_count;
            }
        } else {
            let hit_count = lower
                .split(|c: char| !c.is_alphanumeric() && c != '\'')
                .filter(|tok| *tok == needle)
                .count();
            if hit_count > 0 {
                *counts.entry(needle.to_owned()).or_insert(0) += hit_count;
            }
        }
    }
}

fn compute_clarity_score(words: usize, grammar_hits: usize, slop_hits: usize) -> u8 {
    if words == 0 {
        return 100;
    }
    let issues_per_100 = ((grammar_hits + slop_hits) as f64 / words as f64) * 100.0;
    (100.0 - issues_per_100 * 5.0).clamp(15.0, 100.0).round() as u8
}

fn compute_conciseness_score(words: usize, slop_hits: usize, fixes_applied: usize) -> u8 {
    if words == 0 {
        return 100;
    }
    let slop_per_100 = (slop_hits as f64 / words as f64) * 100.0;
    let fix_bonus = (fixes_applied.min(10) as f64) * 0.5;
    (100.0 - slop_per_100 * 6.0 + fix_bonus)
        .clamp(15.0, 100.0)
        .round() as u8
}

fn round2(val: f64) -> f64 {
    (val * 100.0).round() / 100.0
}

fn compute_perturbed_spans(
    chosen: &str,
    rejected: &str,
    perturbation_type: &str,
) -> Vec<PerturbedSpan> {
    let chosen_chars: Vec<char> = chosen.chars().collect();
    let rejected_chars: Vec<char> = rejected.chars().collect();
    let mut prefix = 0usize;
    while prefix < chosen_chars.len()
        && prefix < rejected_chars.len()
        && chosen_chars[prefix] == rejected_chars[prefix]
    {
        prefix += 1;
    }

    let mut suffix = 0usize;
    while suffix + prefix < chosen_chars.len()
        && suffix + prefix < rejected_chars.len()
        && chosen_chars[chosen_chars.len() - 1 - suffix]
            == rejected_chars[rejected_chars.len() - 1 - suffix]
    {
        suffix += 1;
    }

    let c_end = chosen_chars.len().saturating_sub(suffix);
    let r_end = rejected_chars.len().saturating_sub(suffix);
    if prefix >= r_end && prefix >= c_end {
        return Vec::new();
    }

    let original: String = chosen_chars[prefix..c_end].iter().collect();
    let perturbed: String = rejected_chars[prefix..r_end].iter().collect();
    vec![PerturbedSpan {
        original,
        perturbed,
        start_char: prefix,
        end_char: r_end,
        perturbation_type: perturbation_type.to_owned(),
    }]
}
