use std::collections::HashMap;
use std::fmt;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::secrets::{mask_secret_value, scan_secrets};

/// Public metadata for one redacted secret/PII placeholder (never stores the raw secret).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RedactedPlaceholder {
    pub placeholder: String,
    pub kind: String,
    pub label: String,
    pub masked_preview: String,
}

/// Preview response safe to return over HTTP/RPC without exposing raw sensitive values.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RedactionPreview {
    pub redacted_text: String,
    pub redacted_count: usize,
    pub placeholders: Vec<RedactedPlaceholder>,
}

/// Result of restoring `[LEXEL_REDACTED_n]` placeholders into an AI rewrite.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestorationResult {
    pub text: String,
    pub restored_count: usize,
    pub missing_placeholders: Vec<String>,
    pub stray_placeholders: bool,
    pub restored_cleanly: bool,
}

/// In-memory redaction session that maps `[LEXEL_REDACTED_n]` placeholders back to raw secrets.
/// Raw values are never serialized or printed via `Debug`.
#[derive(Clone)]
pub struct RedactionSession {
    pub redacted_text: String,
    pub placeholders: Vec<RedactedPlaceholder>,
    replacements: Vec<(String, String)>,
}

impl fmt::Debug for RedactionSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RedactionSession")
            .field("redacted_count", &self.placeholders.len())
            .field("placeholders", &self.placeholders)
            .finish()
    }
}

impl RedactionSession {
    /// Return a serializable preview safe for HTTP/RPC responses.
    pub fn preview(&self) -> RedactionPreview {
        RedactionPreview {
            redacted_text: self.redacted_text.clone(),
            redacted_count: self.placeholders.len(),
            placeholders: self.placeholders.clone(),
        }
    }

    /// Number of unique sensitive values replaced.
    pub fn redacted_count(&self) -> usize {
        self.placeholders.len()
    }

    /// Restore all `[LEXEL_REDACTED_n]` tokens in `text` back to their original values
    /// and verify that every placeholder survived the rewrite cleanly.
    pub fn restore(&self, text: &str) -> RestorationResult {
        if self.replacements.is_empty() {
            let stray = has_redaction_placeholder(text);
            return RestorationResult {
                text: text.to_owned(),
                restored_count: 0,
                missing_placeholders: Vec::new(),
                stray_placeholders: stray,
                restored_cleanly: !stray,
            };
        }

        let mut restored = text.to_owned();
        let mut restored_count = 0usize;
        let mut missing_placeholders = Vec::new();

        // Replace higher-numbered placeholders first so `[LEXEL_REDACTED_10]` cannot collide
        // with `[LEXEL_REDACTED_1]` if a model ever drops the closing bracket.
        let mut ordered = self.replacements.clone();
        ordered.sort_by_key(|a| std::cmp::Reverse(a.0.len()));

        for (placeholder, original) in &ordered {
            if restored.contains(placeholder.as_str()) {
                restored = restored.replace(placeholder.as_str(), original);
                restored_count += 1;
            } else {
                missing_placeholders.push(placeholder.clone());
            }
        }

        let stray = has_redaction_placeholder(&restored);
        let restored_cleanly = missing_placeholders.is_empty() && !stray;

        RestorationResult {
            text: restored,
            restored_count,
            missing_placeholders,
            stray_placeholders: stray,
            restored_cleanly,
        }
    }
}

struct RawSpan {
    start: usize,
    end: usize,
    kind: String,
    label: String,
    masked_preview: String,
}

fn email_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b")
            .expect("valid email regex")
    })
}

fn phone_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?:^|[\s(\[])(\+?\d{1,3}[\s.-]?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})(?:$|[\s,.;:!?)\]])",
        )
        .expect("valid phone regex")
    })
}

/// Check whether `text` still contains any `[LEXEL_REDACTED_...]` marker.
pub fn has_redaction_placeholder(text: &str) -> bool {
    text.contains("[LEXEL_REDACTED_")
}

/// Deterministically replace detected secrets and PII (API keys, tokens, private keys, SSNs,
/// payment cards, emails, phone numbers) with `[LEXEL_REDACTED_n]` placeholders for safe local AI
/// processing, returning an in-memory session capable of restoring and verifying the original spans.
pub fn redact_secrets_and_pii(text: &str) -> RedactionSession {
    let mut spans: Vec<RawSpan> = scan_secrets(text)
        .into_iter()
        .map(|hit| RawSpan {
            start: hit.start,
            end: hit.end,
            kind: hit.kind,
            label: hit.label,
            masked_preview: hit.masked_preview,
        })
        .collect();

    for m in email_regex().find_iter(text) {
        if !spans.iter().any(|s| m.start() < s.end && m.end() > s.start) {
            spans.push(RawSpan {
                start: m.start(),
                end: m.end(),
                kind: "email".to_owned(),
                label: "Email address".to_owned(),
                masked_preview: mask_secret_value(m.as_str()),
            });
        }
    }

    for caps in phone_regex().captures_iter(text) {
        let Some(m) = caps.get(1) else {
            continue;
        };
        if !spans.iter().any(|s| m.start() < s.end && m.end() > s.start) {
            spans.push(RawSpan {
                start: m.start(),
                end: m.end(),
                kind: "phone".to_owned(),
                label: "Phone number".to_owned(),
                masked_preview: mask_secret_value(m.as_str()),
            });
        }
    }

    spans.sort_by_key(|s| (s.start, s.end));

    let mut redacted_text = String::with_capacity(text.len());
    let mut cursor = 0usize;
    let mut seen_values: HashMap<String, String> = HashMap::new();
    let mut placeholders = Vec::new();
    let mut replacements = Vec::new();

    for span in spans {
        if span.start < cursor || span.end > text.len() {
            continue;
        }
        redacted_text.push_str(&text[cursor..span.start]);
        let raw_val = &text[span.start..span.end];
        let token = if let Some(existing) = seen_values.get(raw_val) {
            existing.clone()
        } else {
            let next_idx = placeholders.len() + 1;
            let token = format!("[LEXEL_REDACTED_{next_idx}]");
            seen_values.insert(raw_val.to_owned(), token.clone());
            placeholders.push(RedactedPlaceholder {
                placeholder: token.clone(),
                kind: span.kind,
                label: span.label,
                masked_preview: span.masked_preview,
            });
            replacements.push((token.clone(), raw_val.to_owned()));
            token
        };
        redacted_text.push_str(&token);
        cursor = span.end;
    }

    redacted_text.push_str(&text[cursor..]);

    RedactionSession {
        redacted_text,
        placeholders,
        replacements,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_and_restores_secrets_and_emails_cleanly() {
        let input = "Contact alice@example.com with key AKIAIOSFODNN7EXAMPLE and backup AKIAIOSFODNN7EXAMPLE.";
        let session = redact_secrets_and_pii(input);
        assert_eq!(session.redacted_count(), 2);
        assert!(!session.redacted_text.contains("alice@example.com"));
        assert!(!session.redacted_text.contains("AKIAIOSFODNN7EXAMPLE"));
        assert!(session.redacted_text.contains("[LEXEL_REDACTED_1]"));
        assert!(session.redacted_text.contains("[LEXEL_REDACTED_2]"));

        // Simulated model rewrite preserving placeholders
        let rewritten =
            "Email [LEXEL_REDACTED_1] using [LEXEL_REDACTED_2] (backup: [LEXEL_REDACTED_2]).";
        let restored = session.restore(rewritten);
        assert!(restored.restored_cleanly);
        assert_eq!(restored.restored_count, 2);
        assert_eq!(
            restored.text,
            "Email alice@example.com using AKIAIOSFODNN7EXAMPLE (backup: AKIAIOSFODNN7EXAMPLE)."
        );
    }

    #[test]
    fn flags_missing_placeholder_when_model_drops_redacted_token() {
        let input = "Token is sk-proj-abc1234567890abcdef123456.";
        let session = redact_secrets_and_pii(input);
        assert_eq!(session.redacted_count(), 1);

        let dropped = session.restore("Token is omitted.");
        assert!(!dropped.restored_cleanly);
        assert_eq!(dropped.missing_placeholders, vec!["[LEXEL_REDACTED_1]"]);
    }

    #[test]
    fn debug_impl_never_leaks_raw_secret() {
        let secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
        let session = redact_secrets_and_pii(&format!("Use {secret}"));
        let debug_str = format!("{session:?}");
        assert!(!debug_str.contains(secret));
    }
}
