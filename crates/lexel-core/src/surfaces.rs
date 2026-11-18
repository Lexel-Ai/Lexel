use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::CoreError;
use crate::slop::{ignored_prose_ranges, overlaps_ignored_ranges};

const SURFACES_JSON: &str = include_str!("../../../ml/personas/surfaces.json");

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuickActionDef {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceProfile {
    pub id: String,
    pub label: String,
    pub host_patterns: Vec<String>,
    pub path_regex: Option<String>,
    pub register: String,
    pub min_chars: usize,
    pub max_chars: usize,
    pub allow_links: bool,
    pub allow_emojis: bool,
    pub allow_hashtags: bool,
    pub allow_em_dashes: bool,
    pub banned_openers: Vec<String>,
    pub prompt_directive: String,
    pub quick_actions: Vec<QuickActionDef>,
}

#[derive(Debug, Deserialize)]
struct SurfacesFile {
    surfaces: Vec<SurfaceProfile>,
}

/// Violation emitted by surface rule validation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceViolation {
    pub kind: String,
    pub message: String,
    pub start: usize,
    pub end: usize,
}

/// Surface catalog loaded from `ml/personas/surfaces.json`.
#[derive(Debug, Clone)]
pub struct SurfaceCatalog {
    profiles: Vec<SurfaceProfile>,
    url_regex: Regex,
    hashtag_regex: Regex,
    excess_punct_regex: Regex,
    commit_prefix_regex: Regex,
}

impl SurfaceCatalog {
    /// Load embedded platform surface definitions.
    pub fn load_embedded() -> Result<Self, CoreError> {
        Self::load_with_custom(&[])
    }

    /// Load embedded platform surface definitions merged with user-defined custom surfaces.
    pub fn load_with_custom(custom: &[SurfaceProfile]) -> Result<Self, CoreError> {
        let parsed: SurfacesFile = serde_json::from_str(SURFACES_JSON)?;
        let mut profiles = parsed.surfaces;
        for surface in custom {
            if let Some(existing) = profiles.iter_mut().find(|p| p.id == surface.id) {
                *existing = surface.clone();
            } else {
                profiles.push(surface.clone());
            }
        }
        Ok(Self {
            profiles,
            url_regex: Regex::new(r"(?i)https?://[^\s)>\]]+")?,
            hashtag_regex: Regex::new(r"(?:^|\s)(#[a-zA-Z][a-zA-Z0-9_]{1,})")?,
            excess_punct_regex: Regex::new(r"!{3,}|\?{3,}")?,
            commit_prefix_regex: Regex::new(r"^([A-Za-z]+)(?:\(([^)]+)\))?(!)?:\s*(.*)$")?,
        })
    }

    /// Return all defined surfaces.
    pub fn all(&self) -> &[SurfaceProfile] {
        &self.profiles
    }

    /// Look up a surface by ID, falling back to `general`.
    pub fn get(&self, id: &str) -> Result<&SurfaceProfile, CoreError> {
        self.profiles
            .iter()
            .find(|p| p.id == id)
            .or_else(|| self.profiles.iter().find(|p| p.id == "general"))
            .ok_or_else(|| CoreError::UnknownSurface(id.to_owned()))
    }

    /// Validate text against a surface's deterministic bounds and formatting rules.
    pub fn validate(
        &self,
        text: &str,
        surface_id: &str,
    ) -> Result<Vec<SurfaceViolation>, CoreError> {
        let profile = self.get(surface_id)?;
        let mut violations = Vec::new();
        let ignored = ignored_prose_ranges(text);

        let trimmed_start = text.trim_start();
        let leading_offset = text.len().saturating_sub(trimmed_start.len());
        let lower_trimmed = trimmed_start.to_ascii_lowercase();
        for opener in &profile.banned_openers {
            if lower_trimmed.starts_with(opener) {
                violations.push(SurfaceViolation {
                    kind: "opener".to_owned(),
                    message: format!(
                        "Generic opener on {}. Start directly with your point.",
                        profile.label
                    ),
                    start: leading_offset,
                    end: leading_offset + opener.len(),
                });
                break;
            }
        }

        if !profile.allow_links {
            for m in self.url_regex.find_iter(text) {
                if overlaps_ignored_ranges(m.start(), m.end(), &ignored) {
                    continue;
                }
                violations.push(SurfaceViolation {
                    kind: "link".to_owned(),
                    message: format!(
                        "External links are often auto-removed or flagged as spam on {}.",
                        profile.label
                    ),
                    start: m.start(),
                    end: m.end(),
                });
            }
        }

        if !profile.allow_hashtags {
            for caps in self.hashtag_regex.captures_iter(text) {
                if let Some(tag) = caps.get(1) {
                    if overlaps_ignored_ranges(tag.start(), tag.end(), &ignored) {
                        continue;
                    }
                    violations.push(SurfaceViolation {
                        kind: "hashtag".to_owned(),
                        message: format!("Hashtags reduce signal quality on {}.", profile.label),
                        start: tag.start(),
                        end: tag.end(),
                    });
                }
            }
        }

        if !profile.allow_emojis {
            for (idx, ch) in text.char_indices() {
                let end = idx + ch.len_utf8();
                if is_decorative_emoji(ch) && !overlaps_ignored_ranges(idx, end, &ignored) {
                    violations.push(SurfaceViolation {
                        kind: "emoji".to_owned(),
                        message: format!("Decorative emoji flagged by {} profile.", profile.label),
                        start: idx,
                        end,
                    });
                }
            }
        }

        if profile.id != "web_discord_slack" && profile.id != "general" {
            for m in self.excess_punct_regex.find_iter(text) {
                if overlaps_ignored_ranges(m.start(), m.end(), &ignored) {
                    continue;
                }
                violations.push(SurfaceViolation {
                    kind: "excess_punctuation".to_owned(),
                    message: format!(
                        "Repeated punctuation ({}) lowers clarity on {}.",
                        m.as_str(),
                        profile.label
                    ),
                    start: m.start(),
                    end: m.end(),
                });
            }
        }

        if profile.id == "ide_git_commit" {
            self.validate_git_commit(text, &mut violations);
        }

        let char_count = text.chars().count();
        if char_count > profile.max_chars {
            violations.push(SurfaceViolation {
                kind: "length".to_owned(),
                message: format!(
                    "Exceeds {} limit ({char_count}/{} chars).",
                    profile.label, profile.max_chars
                ),
                start: profile.max_chars,
                end: char_count,
            });
        }

        Ok(violations)
    }

    fn validate_git_commit(&self, text: &str, violations: &mut Vec<SurfaceViolation>) {
        let mut offset = 0usize;
        for line in text.split_inclusive('\n') {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                offset += line.len();
                continue;
            }
            let subject = line.trim_end_matches(['\r', '\n']);
            let subject_chars = subject.chars().count();
            if subject_chars > 72 {
                violations.push(SurfaceViolation {
                    kind: "commit_subject_length".to_owned(),
                    message: format!(
                        "Git commit subject should stay <= 72 chars ({subject_chars} chars)."
                    ),
                    start: offset + 72.min(subject.len()),
                    end: offset + subject.len(),
                });
            }
            if subject.ends_with('.') {
                violations.push(SurfaceViolation {
                    kind: "commit_subject_period".to_owned(),
                    message: "Drop the trailing period on Git commit subject lines.".to_owned(),
                    start: offset + subject.len().saturating_sub(1),
                    end: offset + subject.len(),
                });
            }
            let mut summary_part = subject;
            if let Some(caps) = self.commit_prefix_regex.captures(subject)
                && let Some(kind_m) = caps.get(1)
            {
                let ctype = kind_m.as_str();
                const VALID_TYPES: &[&str] = &[
                    "feat", "fix", "perf", "refactor", "sec", "arch", "ml", "sync", "test",
                    "infra", "docs", "revert", "chore", "ci", "build", "style",
                ];
                if !VALID_TYPES.contains(&ctype) {
                    violations.push(SurfaceViolation {
                        kind: "commit_type".to_owned(),
                        message: format!(
                            "Commit prefix \"{ctype}\" should be lowercase standard type (e.g. feat, fix, refactor, docs)."
                        ),
                        start: offset + kind_m.start(),
                        end: offset + kind_m.end(),
                    });
                }
                if let Some(sum_m) = caps.get(4) {
                    summary_part = sum_m.as_str();
                }
            }
            let lower_summary = summary_part.trim_start().to_ascii_lowercase();
            for past in ["added ", "fixed ", "updated ", "removed ", "changed "] {
                if lower_summary.starts_with(past) {
                    let past_start = offset
                        + (subject
                            .len()
                            .saturating_sub(summary_part.trim_start().len()));
                    violations.push(SurfaceViolation {
                        kind: "commit_mood".to_owned(),
                        message: "Use imperative mood in commit subjects (e.g. \"add\" instead of \"added\").".to_owned(),
                        start: past_start,
                        end: past_start + past.trim_end().len(),
                    });
                    break;
                }
            }
            break;
        }
    }
}

fn is_decorative_emoji(ch: char) -> bool {
    let cp = ch as u32;
    matches!(
        cp,
        0x1F300..=0x1FAFF | 0x2600..=0x27BF | 0x2300..=0x23FF
    )
}
