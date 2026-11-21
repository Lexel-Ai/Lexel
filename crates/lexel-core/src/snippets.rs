use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::profile::TextSnippet;
use crate::surfaces::SurfaceCatalog;

/// Unified snippet representation returned to clients (built-in + custom user snippets).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnippetEntry {
    pub trigger: String,
    pub expansion: String,
    pub label: String,
    #[serde(default)]
    pub surface_id: Option<String>,
    #[serde(default)]
    pub adapt_to_surface: bool,
    #[serde(default)]
    pub category: Option<String>,
    pub built_in: bool,
}

/// Result of deterministic snippet expansion before optional AI surface adaptation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExpandedSnippet {
    pub trigger: String,
    pub raw_expansion: String,
    pub expanded_text: String,
    pub surface_id: String,
    pub adapt_to_surface: bool,
}

/// Built-in context-aware snippets shipped with Lexel (`/standup`, `/lgtm`, `/decline`, `/followup`, `/bug`).
pub fn builtin_snippets() -> Vec<TextSnippet> {
    vec![
        TextSnippet {
            trigger: "/standup".to_owned(),
            expansion: "Yesterday:\n- {{notes}}\n\nToday:\n- \n\nBlockers:\n- None".to_owned(),
            label: "Daily standup update".to_owned(),
            surface_id: None,
            adapt_to_surface: true,
            category: Some("status".to_owned()),
        },
        TextSnippet {
            trigger: "/lgtm".to_owned(),
            expansion: "Looks good to me. No blocking issues.".to_owned(),
            label: "Code review approval".to_owned(),
            surface_id: None,
            adapt_to_surface: true,
            category: Some("code-review".to_owned()),
        },
        TextSnippet {
            trigger: "/decline".to_owned(),
            expansion: "Thanks for reaching out. I need to pass on this right now to stay focused on current priorities.".to_owned(),
            label: "Direct polite decline".to_owned(),
            surface_id: None,
            adapt_to_surface: true,
            category: Some("reply".to_owned()),
        },
        TextSnippet {
            trigger: "/followup".to_owned(),
            expansion: "Checking in on this when you have a moment. Let me know if anything is blocking next steps.".to_owned(),
            label: "Concise follow-up".to_owned(),
            surface_id: None,
            adapt_to_surface: true,
            category: Some("reply".to_owned()),
        },
        TextSnippet {
            trigger: "/bug".to_owned(),
            expansion: "Summary: {{notes}}\n\nSteps to reproduce:\n1. \n\nExpected:\n- \n\nActual:\n- ".to_owned(),
            label: "Structured bug report".to_owned(),
            surface_id: None,
            adapt_to_surface: true,
            category: Some("engineering".to_owned()),
        },
    ]
}

/// Merge built-in snippets with user-defined snippets (user triggers override built-ins).
pub fn merged_snippets(user_snippets: &[TextSnippet]) -> Vec<SnippetEntry> {
    let mut entries: Vec<SnippetEntry> = Vec::new();

    for user in user_snippets {
        let clean = user.trigger.trim();
        if clean.is_empty() {
            continue;
        }
        entries.push(SnippetEntry {
            trigger: clean.to_owned(),
            expansion: user.expansion.clone(),
            label: if user.label.trim().is_empty() {
                clean.to_owned()
            } else {
                user.label.clone()
            },
            surface_id: user.surface_id.clone(),
            adapt_to_surface: user.adapt_to_surface,
            category: user.category.clone(),
            built_in: false,
        });
    }

    for builtin in builtin_snippets() {
        if !entries
            .iter()
            .any(|e| e.trigger.eq_ignore_ascii_case(&builtin.trigger))
        {
            entries.push(SnippetEntry {
                trigger: builtin.trigger,
                expansion: builtin.expansion,
                label: builtin.label,
                surface_id: builtin.surface_id,
                adapt_to_surface: builtin.adapt_to_surface,
                category: builtin.category,
                built_in: true,
            });
        }
    }

    entries
}

/// Expand a snippet trigger deterministically (<1 ms) with placeholder substitution and
/// optional surface register adaptation.
pub fn expand_snippet_deterministic(
    trigger: &str,
    surface_id: &str,
    subcontext: Option<&str>,
    notes: Option<&str>,
    user_snippets: &[TextSnippet],
) -> Option<ExpandedSnippet> {
    let query = trigger.trim();
    if query.is_empty() {
        return None;
    }

    let all = merged_snippets(user_snippets);
    let matched = all.into_iter().find(|entry| {
        entry.trigger.eq_ignore_ascii_case(query)
            || entry
                .trigger
                .strip_prefix('/')
                .is_some_and(|bare| bare.eq_ignore_ascii_case(query))
    })?;

    let target_surface = matched
        .surface_id
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(surface_id);

    let raw_template = if matched.built_in && matched.adapt_to_surface {
        builtin_surface_variant(&matched.trigger, target_surface)
            .map(str::to_owned)
            .unwrap_or_else(|| matched.expansion.clone())
    } else {
        matched.expansion.clone()
    };

    let today = utc_date_iso();
    let notes_text = notes.map(str::trim).unwrap_or("");
    let sub_text = subcontext.map(str::trim).unwrap_or("");

    let mut expanded = raw_template
        .replace("{{date}}", &today)
        .replace("{{surface}}", target_surface)
        .replace("{{subcontext}}", sub_text)
        .replace("{{notes}}", notes_text);

    // Clean up empty trailing bullet space if {{notes}} was empty.
    expanded = expanded
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned();

    // Respect surface max_chars deterministically if catalog has the surface.
    if let Ok(catalog) = SurfaceCatalog::load_embedded()
        && let Ok(profile) = catalog.get(target_surface)
        && expanded.chars().count() > profile.max_chars
    {
        expanded = expanded.chars().take(profile.max_chars).collect();
    }

    Some(ExpandedSnippet {
        trigger: matched.trigger,
        raw_expansion: matched.expansion,
        expanded_text: expanded,
        surface_id: target_surface.to_owned(),
        adapt_to_surface: matched.adapt_to_surface,
    })
}

fn builtin_surface_variant(trigger: &str, surface_id: &str) -> Option<&'static str> {
    let lower_trigger = trigger.to_ascii_lowercase();
    let norm_surface = surface_id.to_ascii_lowercase();

    match lower_trigger.as_str() {
        "/lgtm" => {
            if norm_surface.contains("github") || norm_surface.contains("pr") {
                Some("LGTM. Reviewed the diff and found no blocking issues. {{notes}}")
            } else if norm_surface.contains("slack") || norm_surface.contains("discord") {
                Some("Looks good, ready to ship. {{notes}}")
            } else if norm_surface.contains("email") || norm_surface.contains("gmail") {
                Some("This looks good to me. Ready to move forward. {{notes}}")
            } else {
                None
            }
        }
        "/decline" => {
            if norm_surface.contains("slack") || norm_surface.contains("discord") {
                Some("Passing on this for now so I can stay focused on current work. {{notes}}")
            } else if norm_surface.contains("email") || norm_surface.contains("gmail") {
                Some(
                    "Thanks for reaching out. I need to pass on this right now due to current commitments. {{notes}}",
                )
            } else if norm_surface.contains("x_") || norm_surface == "web_x" {
                Some("Passing on this one for now, appreciate the invite. {{notes}}")
            } else {
                None
            }
        }
        "/standup" => {
            if norm_surface.contains("slack") || norm_surface.contains("discord") {
                Some("Standup ({{date}}):\n- Yesterday: {{notes}}\n- Today: \n- Blockers: None")
            } else if norm_surface.contains("email") || norm_surface.contains("gmail") {
                Some("Daily update ({{date}}):\n\nCompleted: {{notes}}\nNext: \nBlockers: None")
            } else {
                None
            }
        }
        "/followup" => {
            if norm_surface.contains("slack") || norm_surface.contains("discord") {
                Some("Quick ping on this when you get a chance. {{notes}}")
            } else if norm_surface.contains("email") || norm_surface.contains("gmail") {
                Some(
                    "Following up on this thread. Let me know if you need anything else from my side. {{notes}}",
                )
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Compute `YYYY-MM-DD` in UTC without external date crates (Howard Hinnant's civil-from-days).
fn utc_date_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let z = secs.div_euclid(86_400) + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{year:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_builtin_snippets_with_surface_adaptation() {
        let pr = expand_snippet_deterministic("/lgtm", "web_github_pr", None, None, &[])
            .expect("pr snippet");
        assert!(pr.expanded_text.contains("LGTM"));
        assert!(!pr.expanded_text.contains('—'));

        let slack = expand_snippet_deterministic(
            "/standup",
            "web_discord_slack",
            None,
            Some("Merged PR #42"),
            &[],
        )
        .expect("standup snippet");
        assert!(slack.expanded_text.contains("Merged PR #42"));
        assert!(slack.expanded_text.contains("Standup ("));
    }

    #[test]
    fn user_snippet_overrides_builtin_trigger() {
        let custom = vec![TextSnippet {
            trigger: "/lgtm".to_owned(),
            expansion: "Ship it!".to_owned(),
            label: "My LGTM".to_owned(),
            surface_id: None,
            adapt_to_surface: false,
            category: None,
        }];
        let out = expand_snippet_deterministic("/lgtm", "web_github_pr", None, None, &custom)
            .expect("custom snippet");
        assert_eq!(out.expanded_text, "Ship it!");
    }
}
