use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

/// Deterministic match for an API key, token, private key header, SSN, or Luhn card number.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecretMatch {
    pub kind: String,
    pub label: String,
    pub start: usize,
    pub end: usize,
    pub masked_preview: String,
}

struct SecretRule {
    kind: &'static str,
    label: &'static str,
    regex: Regex,
}

fn secret_rules() -> &'static [SecretRule] {
    static RULES: OnceLock<Vec<SecretRule>> = OnceLock::new();
    RULES.get_or_init(|| {
        vec![
            SecretRule {
                kind: "private_key",
                label: "Private key block",
                regex: Regex::new(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----")
                    .expect("valid private key regex"),
            },
            SecretRule {
                kind: "jwt",
                label: "JSON Web Token",
                regex: Regex::new(
                    r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b",
                )
                .expect("valid jwt regex"),
            },
            SecretRule {
                kind: "github_token",
                label: "GitHub personal access token",
                regex: Regex::new(
                    r"\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b",
                )
                .expect("valid github token regex"),
            },
            SecretRule {
                kind: "aws_access_key",
                label: "AWS access key ID",
                regex: Regex::new(r"\bAKIA[0-9A-Z]{16}\b").expect("valid aws regex"),
            },
            SecretRule {
                kind: "google_api_key",
                label: "Google API key",
                regex: Regex::new(r"\bAIza[0-9A-Za-z_-]{35}\b").expect("valid google regex"),
            },
            SecretRule {
                kind: "slack_token",
                label: "Slack token",
                regex: Regex::new(r"\bxox[baprs]-[0-9A-Za-z-]{16,}\b").expect("valid slack regex"),
            },
            SecretRule {
                kind: "api_key",
                label: "API secret key",
                regex: Regex::new(r"\bsk-(?:proj-|ant-[a-z0-9-]+-)?[A-Za-z0-9_-]{16,}\b")
                    .expect("valid api key regex"),
            },
            SecretRule {
                kind: "bearer_token",
                label: "Bearer auth header",
                regex: Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{16,}")
                    .expect("valid bearer regex"),
            },
            SecretRule {
                kind: "ssn",
                label: "US SSN-like number",
                regex: Regex::new(r"\b(?:00[1-9]|0[1-9]\d|[1-5]\d{2}|6(?:[0-5]\d|6[0-5]|6[7-9]|[7-9]\d)|[78]\d{2})-(?:0[1-9]|[1-9]\d)-(?:000[1-9]|00[1-9]\d|0[1-9]\d{2}|[1-9]\d{3})\b")
                    .expect("valid ssn regex"),
            },
        ]
    })
}

fn card_candidate_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?:\b|\s|^)(\d(?:[\s-]?\d){12,18})(?:\b|$)")
            .expect("valid card candidate regex")
    })
}

/// Mask a sensitive span so logs and diagnostics never expose raw credentials or PII.
pub fn mask_secret_value(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.len() <= 6 {
        return "[REDACTED]".to_owned();
    }
    let prefix: String = trimmed.chars().take(3).collect();
    format!("{prefix}***({} chars)", trimmed.chars().count())
}

fn passes_luhn(digits: &str) -> bool {
    if !(13..=19).contains(&digits.len()) || digits.bytes().all(|b| b == b'0') {
        return false;
    }
    let mut sum = 0u32;
    let mut double_next = false;
    for b in digits.bytes().rev() {
        let mut d = u32::from(b - b'0');
        if double_next {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
        double_next = !double_next;
    }
    sum.is_multiple_of(10)
}

/// Deterministically scan `text` for credentials, tokens, private keys, SSNs, and Luhn cards.
pub fn scan_secrets(text: &str) -> Vec<SecretMatch> {
    let mut matches = Vec::new();

    for rule in secret_rules() {
        for m in rule.regex.find_iter(text) {
            matches.push(SecretMatch {
                kind: rule.kind.to_owned(),
                label: rule.label.to_owned(),
                start: m.start(),
                end: m.end(),
                masked_preview: mask_secret_value(m.as_str()),
            });
        }
    }

    for caps in card_candidate_regex().captures_iter(text) {
        let Some(m) = caps.get(1) else {
            continue;
        };
        let digits: String = m.as_str().chars().filter(|c| c.is_ascii_digit()).collect();
        if passes_luhn(&digits) {
            let overlaps_existing = matches
                .iter()
                .any(|existing| m.start() < existing.end && m.end() > existing.start);
            if !overlaps_existing {
                matches.push(SecretMatch {
                    kind: "payment_card".to_owned(),
                    label: "Payment card number".to_owned(),
                    start: m.start(),
                    end: m.end(),
                    masked_preview: mask_secret_value(m.as_str()),
                });
            }
        }
    }

    matches.sort_by_key(|m| (m.start, m.end));
    matches
}
