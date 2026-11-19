use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use lexel_core::{LexelProfile, MainModelTier, SurfaceCatalog, UnifiedSettings, VoiceExample};
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

    /// Purge all stored user voice examples and reset profiles back to a clean default.
    pub fn purge_all(&self) -> Result<LexelProfile, DbError> {
        self.conn.execute_batch(
            "DELETE FROM voice_examples_fts;
             DELETE FROM voice_examples;
             DELETE FROM sub_contexts;
             DELETE FROM profiles;",
        )?;
        self.ensure_default_profile()?;
        self.active_profile()
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
