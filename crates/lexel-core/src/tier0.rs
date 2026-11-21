use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::CoreError;
use crate::cache::{ParagraphCacheStats, ParagraphLintCache, fnv1a_64};
use crate::consistency::{ConsistencyIssue, scan_consistency_issues};
use crate::guards::{WritingGuardHit, scan_writing_guards};
use crate::harper::{HarperDiagnostic, HarperEngine};
use crate::profile::{StoredWeirpack, StyleGuideRule};
use crate::quality::{
    InvisibleCharHit, StructureIssue, StyleGuideHit, apply_style_guide_fixes, scan_invisible_chars,
    scan_structure_issues, scan_style_guide,
};
use crate::secrets::{SecretMatch, scan_secrets};
use crate::slop::{SlopHit, SlopScanner};
use crate::slop_meter::{SlopMeterOptions, SlopMeterReport, score_slop_meter};
use crate::surfaces::{SurfaceCatalog, SurfaceProfile, SurfaceViolation};
use crate::verifier::{SafeFixResult, apply_safe_deterministic_fixes};

fn default_surface_id() -> String {
    "general".to_owned()
}

fn default_language() -> String {
    "plaintext".to_owned()
}

/// Configuration options for running a unified deterministic Tier 0 check.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tier0CheckOptions {
    #[serde(default = "default_surface_id")]
    pub surface_id: String,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default)]
    pub dialect: u8,
    #[serde(default)]
    pub lint_config: BTreeMap<String, Option<bool>>,
    #[serde(default)]
    pub user_dictionary: Vec<String>,
    #[serde(default)]
    pub ignored_lints: String,
    #[serde(default)]
    pub custom_slop_terms: Vec<String>,
    #[serde(default)]
    pub disabled_slop_terms: Vec<String>,
    #[serde(default)]
    pub custom_surfaces: Vec<SurfaceProfile>,
    #[serde(default)]
    pub style_guide: Vec<StyleGuideRule>,
    #[serde(default)]
    pub crutch_words: Vec<String>,
    #[serde(default)]
    pub weirpacks: Vec<StoredWeirpack>,
    #[serde(default)]
    pub has_attachment_signal: bool,
}

impl Default for Tier0CheckOptions {
    fn default() -> Self {
        Self {
            surface_id: default_surface_id(),
            language: default_language(),
            dialect: 0,
            lint_config: BTreeMap::new(),
            user_dictionary: Vec::new(),
            ignored_lints: String::new(),
            custom_slop_terms: Vec::new(),
            disabled_slop_terms: Vec::new(),
            custom_surfaces: Vec::new(),
            style_guide: Vec::new(),
            crutch_words: Vec::new(),
            weirpacks: Vec::new(),
            has_attachment_signal: false,
        }
    }
}

/// Complete deterministic Tier 0 check report (zero AI, <5 ms target).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tier0Report {
    pub harper: Vec<HarperDiagnostic>,
    pub slop: Vec<SlopHit>,
    pub surface: Vec<SurfaceViolation>,
    pub secrets: Vec<SecretMatch>,
    pub invisible_chars: Vec<InvisibleCharHit>,
    pub structure: Vec<StructureIssue>,
    pub style_guide: Vec<StyleGuideHit>,
    pub slop_meter: SlopMeterReport,
    pub consistency: Vec<ConsistencyIssue>,
    pub guards: Vec<WritingGuardHit>,
    pub safe_fixed_text: String,
    pub safe_fixes_count: usize,
    pub cache_stats: ParagraphCacheStats,
}

/// Stateful Tier 0 engine that caches the Harper engine and per-paragraph diagnostics across checks.
pub struct Tier0Engine {
    harper: Option<HarperEngine>,
    harper_fingerprint: u64,
    cache: ParagraphLintCache,
}

impl Default for Tier0Engine {
    fn default() -> Self {
        Self::new()
    }
}

impl Tier0Engine {
    /// Create a new Tier 0 engine with an empty paragraph-hash cache.
    pub fn new() -> Self {
        Self {
            harper: None,
            harper_fingerprint: 0,
            cache: ParagraphLintCache::default(),
        }
    }

    /// Create a Tier 0 engine with a custom paragraph cache capacity.
    pub fn with_cache_capacity(max_entries: usize) -> Self {
        Self {
            harper: None,
            harper_fingerprint: 0,
            cache: ParagraphLintCache::new(max_entries),
        }
    }

    /// Clear the paragraph-hash cache (for example after explicit user reset).
    pub fn clear_cache(&mut self) {
        self.cache.clear();
    }

    /// Return the number of cached paragraph entries.
    pub fn cached_paragraphs(&self) -> usize {
        self.cache.len()
    }

    /// Run all deterministic Tier 0 checks (Harper, anti-slop, slop meter, surface, consistency,
    /// BLUF/wall-of-text, regret shield, crutch words, secrets, invisible chars, structure, style guide).
    pub fn check(
        &mut self,
        text: &str,
        opts: &Tier0CheckOptions,
    ) -> Result<Tier0Report, CoreError> {
        let surface_id = if opts.surface_id.trim().is_empty() {
            "general"
        } else {
            opts.surface_id.as_str()
        };
        let language = if opts.language.trim().is_empty() {
            "plaintext"
        } else {
            opts.language.as_str()
        };

        let custom_catalog = if opts.custom_surfaces.is_empty() {
            None
        } else {
            Some(SurfaceCatalog::load_with_custom(&opts.custom_surfaces)?)
        };
        let catalog: &SurfaceCatalog = match custom_catalog.as_ref() {
            Some(c) => c,
            None => SurfaceCatalog::shared(),
        };
        let surface_profile = catalog.get(surface_id)?;
        let slop_scanner = SlopScanner::shared();

        let harper_fp = self.ensure_harper(opts)?;
        let cache_fp = combine_fingerprint(harper_fp, language);
        let (harper, cache_stats) = {
            let engine = self
                .harper
                .as_mut()
                .expect("ensure_harper always initializes harper engine");
            self.cache.check_harper(engine, text, language, cache_fp)
        };

        let slop = slop_scanner.scan_with_overrides(
            text,
            surface_profile.allow_em_dashes,
            &opts.custom_slop_terms,
            &opts.disabled_slop_terms,
        );
        let surface = catalog.validate(text, surface_id)?;
        let secrets = scan_secrets(text);
        let invisible_chars = scan_invisible_chars(text);
        let structure = scan_structure_issues(text);
        let style_guide = scan_style_guide(text, &opts.style_guide);

        let meter_opts = SlopMeterOptions {
            allow_em_dashes: surface_profile.allow_em_dashes,
            custom_slop_terms: opts.custom_slop_terms.clone(),
            disabled_slop_terms: opts.disabled_slop_terms.clone(),
            surface_banned_openers: surface_profile.banned_openers.clone(),
        };
        let slop_meter = score_slop_meter(text, &meter_opts);

        let preferred_dialect = if opts.dialect <= 1 {
            Some(opts.dialect)
        } else {
            None
        };
        let consistency = scan_consistency_issues(text, preferred_dialect);
        let guards = scan_writing_guards(
            text,
            surface_id,
            &opts.crutch_words,
            opts.has_attachment_signal,
        );

        let safe_fix = apply_safe_deterministic_fixes(
            text,
            surface_id,
            &opts.custom_slop_terms,
            &opts.disabled_slop_terms,
            &opts.custom_surfaces,
        )?;
        let style_fix = apply_style_guide_fixes(&safe_fix.text, &opts.style_guide);

        Ok(Tier0Report {
            harper,
            slop,
            surface,
            secrets,
            invisible_chars,
            structure,
            style_guide,
            slop_meter,
            consistency,
            guards,
            safe_fixed_text: style_fix.text,
            safe_fixes_count: safe_fix.fixes_applied + style_fix.fixes_applied,
            cache_stats,
        })
    }

    /// Run only Harper diagnostics with paragraph-hash caching.
    pub fn check_harper(
        &mut self,
        text: &str,
        opts: &Tier0CheckOptions,
    ) -> Result<(Vec<HarperDiagnostic>, ParagraphCacheStats), CoreError> {
        let language = if opts.language.trim().is_empty() {
            "plaintext"
        } else {
            opts.language.as_str()
        };
        let harper_fp = self.ensure_harper(opts)?;
        let cache_fp = combine_fingerprint(harper_fp, language);
        let engine = self
            .harper
            .as_mut()
            .expect("ensure_harper always initializes harper engine");
        Ok(self.cache.check_harper(engine, text, language, cache_fp))
    }

    /// Deterministically apply safe slop, surface, style-guide, and optional single-suggestion Harper fixes.
    pub fn apply_safe_fixes(
        &mut self,
        text: &str,
        opts: &Tier0CheckOptions,
        include_harper: bool,
    ) -> Result<SafeFixResult, CoreError> {
        let surface_id = if opts.surface_id.trim().is_empty() {
            "general"
        } else {
            opts.surface_id.as_str()
        };
        let language = if opts.language.trim().is_empty() {
            "plaintext"
        } else {
            opts.language.as_str()
        };

        let deterministic = apply_safe_deterministic_fixes(
            text,
            surface_id,
            &opts.custom_slop_terms,
            &opts.disabled_slop_terms,
            &opts.custom_surfaces,
        )?;
        let styled = apply_style_guide_fixes(&deterministic.text, &opts.style_guide);

        let mut categories = deterministic.categories;
        for cat in styled.categories {
            if !categories.contains(&cat) {
                categories.push(cat);
            }
        }
        let mut total_fixes = deterministic.fixes_applied + styled.fixes_applied;
        let mut final_text = styled.text;

        if include_harper {
            self.ensure_harper(opts)?;
            let engine = self
                .harper
                .as_mut()
                .expect("ensure_harper always initializes harper engine");
            let grammar = engine.apply_safe_harper_fixes(&final_text, language);
            total_fixes += grammar.fixes_applied;
            final_text = grammar.text;
            for cat in grammar.categories {
                if !categories.contains(&cat) {
                    categories.push(cat);
                }
            }
        }

        Ok(SafeFixResult {
            text: final_text,
            fixes_applied: total_fixes,
            categories,
        })
    }

    fn ensure_harper(&mut self, opts: &Tier0CheckOptions) -> Result<u64, CoreError> {
        let fp = harper_config_fingerprint(opts);
        if self.harper.is_none() || self.harper_fingerprint != fp {
            let mut engine = HarperEngine::new(
                opts.dialect,
                &opts.lint_config,
                &opts.user_dictionary,
                &opts.ignored_lints,
            )?;
            engine.load_stored_weirpacks(&opts.weirpacks);
            self.harper = Some(engine);
            self.harper_fingerprint = fp;
        }
        Ok(fp)
    }
}

/// Stateless one-shot helper running the complete Tier 0 check pipeline.
pub fn run_tier0_check(text: &str, opts: &Tier0CheckOptions) -> Result<Tier0Report, CoreError> {
    let mut engine = Tier0Engine::new();
    engine.check(text, opts)
}

fn harper_config_fingerprint(opts: &Tier0CheckOptions) -> u64 {
    let mut buf = Vec::with_capacity(256);
    buf.push(opts.dialect);
    buf.push(0x1f);
    for (k, v) in &opts.lint_config {
        buf.extend_from_slice(k.as_bytes());
        buf.push(b'=');
        buf.push(match v {
            Some(true) => b'1',
            Some(false) => b'0',
            None => b'n',
        });
        buf.push(b';');
    }
    buf.push(0x1e);
    for word in &opts.user_dictionary {
        buf.extend_from_slice(word.as_bytes());
        buf.push(b',');
    }
    buf.push(0x1d);
    buf.extend_from_slice(opts.ignored_lints.as_bytes());
    buf.push(0x1c);
    for pack in &opts.weirpacks {
        if pack.enabled {
            buf.extend_from_slice(pack.name.as_bytes());
            buf.push(b':');
            buf.extend_from_slice(pack.bytes_base64.as_bytes());
            buf.push(b';');
        }
    }
    fnv1a_64(&buf)
}

fn combine_fingerprint(harper_fp: u64, language: &str) -> u64 {
    let mut buf = Vec::with_capacity(8 + language.len());
    buf.extend_from_slice(&harper_fp.to_le_bytes());
    buf.extend_from_slice(language.trim().to_ascii_lowercase().as_bytes());
    fnv1a_64(&buf)
}
