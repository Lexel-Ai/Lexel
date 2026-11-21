use lexel_core::{
    ConsistencyIssue, HarperDiagnostic, PastedAiAssessment, PastedAiThresholds, SlopMeterOptions,
    SlopMeterReport, SurfaceCatalog, Tier0CheckOptions, Tier0Engine, Tier0Report, WritingGuardHit,
    analyze_readability, detect_pasted_ai_with_thresholds, normalize_typography,
    scan_consistency_issues, scan_writing_guards, score_slop_meter, to_sentence_case,
    to_title_case,
};
use serde::Serialize;
use serde_wasm_bindgen::Serializer;
use wasm_bindgen::prelude::*;

/// Install panic hook once when the WASM module initializes.
#[wasm_bindgen(start)]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}

fn to_js<T: Serialize + ?Sized>(value: &T) -> Result<JsValue, JsValue> {
    let serializer = Serializer::json_compatible();
    value
        .serialize(&serializer)
        .map_err(|err| JsValue::from_str(&err.to_string()))
}

fn parse_optional<T: serde::de::DeserializeOwned + Default>(raw: JsValue) -> Result<T, JsValue> {
    if raw.is_null() || raw.is_undefined() {
        return Ok(T::default());
    }
    serde_wasm_bindgen::from_value(raw).map_err(|err| JsValue::from_str(&err.to_string()))
}

/// Converts Rust UTF-8 byte offsets and Harper char offsets to JavaScript UTF-16 code-unit offsets.
struct Utf16Mapper<'a> {
    text: &'a str,
    is_ascii: bool,
}

impl<'a> Utf16Mapper<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            text,
            is_ascii: text.is_ascii(),
        }
    }

    fn byte_to_utf16(&self, byte_idx: usize) -> usize {
        if self.is_ascii {
            return byte_idx.min(self.text.len());
        }
        let clamped = byte_idx.min(self.text.len());
        // Walk back to a char boundary if a span ever lands mid-sequence.
        let mut idx = clamped;
        while idx > 0 && !self.text.is_char_boundary(idx) {
            idx -= 1;
        }
        self.text[..idx].encode_utf16().count()
    }

    fn char_to_utf16(&self, char_idx: usize) -> usize {
        if self.is_ascii {
            return char_idx.min(self.text.len());
        }
        self.text.chars().take(char_idx).map(char::len_utf16).sum()
    }
}

fn convert_harper_spans(text: &str, diags: &mut [HarperDiagnostic]) {
    let mapper = Utf16Mapper::new(text);
    for d in diags {
        d.start = mapper.char_to_utf16(d.start);
        d.end = mapper.char_to_utf16(d.end);
    }
}

fn convert_slop_meter_spans(text: &str, report: &mut SlopMeterReport) {
    let mapper = Utf16Mapper::new(text);
    for span in &mut report.contributors {
        span.start = mapper.byte_to_utf16(span.start);
        span.end = mapper.byte_to_utf16(span.end);
    }
}

fn convert_consistency_spans(text: &str, issues: &mut [ConsistencyIssue]) {
    let mapper = Utf16Mapper::new(text);
    for issue in issues {
        issue.start = mapper.byte_to_utf16(issue.start);
        issue.end = mapper.byte_to_utf16(issue.end);
    }
}

fn convert_guard_spans(text: &str, hits: &mut [WritingGuardHit]) {
    let mapper = Utf16Mapper::new(text);
    for hit in hits {
        hit.start = mapper.byte_to_utf16(hit.start);
        hit.end = mapper.byte_to_utf16(hit.end);
    }
}

fn convert_tier0_report_spans(text: &str, report: &mut Tier0Report) {
    let mapper = Utf16Mapper::new(text);
    for d in &mut report.harper {
        d.start = mapper.char_to_utf16(d.start);
        d.end = mapper.char_to_utf16(d.end);
    }
    for hit in &mut report.slop {
        hit.start = mapper.byte_to_utf16(hit.start);
        hit.end = mapper.byte_to_utf16(hit.end);
    }
    for v in &mut report.surface {
        if v.kind == "length" {
            v.start = mapper.char_to_utf16(v.start);
            v.end = mapper.char_to_utf16(v.end);
        } else {
            v.start = mapper.byte_to_utf16(v.start);
            v.end = mapper.byte_to_utf16(v.end);
        }
    }
    for s in &mut report.secrets {
        s.start = mapper.byte_to_utf16(s.start);
        s.end = mapper.byte_to_utf16(s.end);
    }
    for inv in &mut report.invisible_chars {
        inv.start = mapper.byte_to_utf16(inv.start);
        inv.end = mapper.byte_to_utf16(inv.end);
    }
    for st in &mut report.structure {
        st.start = mapper.byte_to_utf16(st.start);
        st.end = mapper.byte_to_utf16(st.end);
    }
    for sg in &mut report.style_guide {
        sg.start = mapper.byte_to_utf16(sg.start);
        sg.end = mapper.byte_to_utf16(sg.end);
    }
    convert_slop_meter_spans(text, &mut report.slop_meter);
    convert_consistency_spans(text, &mut report.consistency);
    convert_guard_spans(text, &mut report.guards);
}

/// Stateful WebAssembly Tier 0 engine holding the cached Harper linter and paragraph-hash cache.
#[wasm_bindgen]
pub struct LexelWasmEngine {
    inner: Tier0Engine,
}

#[wasm_bindgen]
impl LexelWasmEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Tier0Engine::new(),
        }
    }

    /// Run the full Tier 0 check suite (Harper, slop meter, consistency, guards, secrets, structure,
    /// style guide, safe fixes) with paragraph-hash caching. All returned spans use UTF-16 JS indices.
    pub fn check(&mut self, text: &str, options: JsValue) -> Result<JsValue, JsValue> {
        let opts: Tier0CheckOptions = parse_optional(options)?;
        let mut report = self
            .inner
            .check(text, &opts)
            .map_err(|err| JsValue::from_str(&err.to_string()))?;
        convert_tier0_report_spans(text, &mut report);
        to_js(&report)
    }

    /// Run only Harper diagnostics with paragraph-hash caching. Spans use UTF-16 JS indices.
    pub fn check_harper(&mut self, text: &str, options: JsValue) -> Result<JsValue, JsValue> {
        let opts: Tier0CheckOptions = parse_optional(options)?;
        let (mut diags, _stats) = self
            .inner
            .check_harper(text, &opts)
            .map_err(|err| JsValue::from_str(&err.to_string()))?;
        convert_harper_spans(text, &mut diags);
        to_js(&diags)
    }

    /// Apply deterministic safe fixes (slop, surface cleanup, invisible chars, style guide,
    /// and optionally unambiguous Harper grammar fixes).
    pub fn apply_safe_fixes(
        &mut self,
        text: &str,
        options: JsValue,
        include_harper: Option<bool>,
    ) -> Result<JsValue, JsValue> {
        let opts: Tier0CheckOptions = parse_optional(options)?;
        let result = self
            .inner
            .apply_safe_fixes(text, &opts, include_harper.unwrap_or(true))
            .map_err(|err| JsValue::from_str(&err.to_string()))?;
        to_js(&result)
    }

    /// Clear cached paragraph diagnostics.
    pub fn clear_cache(&mut self) {
        self.inner.clear_cache();
    }

    /// Return the number of cached paragraphs currently held by this engine.
    pub fn cached_paragraphs(&self) -> usize {
        self.inner.cached_paragraphs()
    }
}

impl Default for LexelWasmEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// Score text with the Live Human vs. AI-slop meter. Spans use UTF-16 JS indices.
#[wasm_bindgen]
pub fn score_slop_meter_wasm(text: &str, options: JsValue) -> Result<JsValue, JsValue> {
    let opts: SlopMeterOptions = parse_optional(options)?;
    let mut report = score_slop_meter(text, &opts);
    convert_slop_meter_spans(text, &mut report);
    to_js(&report)
}

/// Decide whether pasted text should surface the "Humanize pasted text" pill.
#[wasm_bindgen]
pub fn detect_pasted_ai_wasm(
    text: &str,
    options: JsValue,
    thresholds: JsValue,
) -> Result<JsValue, JsValue> {
    let opts: SlopMeterOptions = parse_optional(options)?;
    let thresh: PastedAiThresholds = parse_optional(thresholds)?;
    let mut assessment: PastedAiAssessment = detect_pasted_ai_with_thresholds(text, &opts, &thresh);
    convert_slop_meter_spans(text, &mut assessment.meter);
    to_js(&assessment)
}

/// Run the document-wide consistency checker (US/UK spelling, hyphenation, product casing, versions).
#[wasm_bindgen]
pub fn check_consistency_wasm(
    text: &str,
    preferred_dialect: Option<u8>,
) -> Result<JsValue, JsValue> {
    let mut issues = scan_consistency_issues(text, preferred_dialect);
    convert_consistency_spans(text, &mut issues);
    to_js(&issues)
}

/// Run BLUF/wall-of-text, regret shield, and personal crutch-word guards.
#[wasm_bindgen]
pub fn check_guards_wasm(
    text: &str,
    surface_id: Option<String>,
    crutch_words: JsValue,
    has_attachment_signal: Option<bool>,
) -> Result<JsValue, JsValue> {
    let surface = surface_id.as_deref().unwrap_or("general");
    let crutch: Vec<String> = parse_optional(crutch_words)?;
    let mut hits = scan_writing_guards(
        text,
        surface,
        &crutch,
        has_attachment_signal.unwrap_or(false),
    );
    convert_guard_spans(text, &mut hits);
    to_js(&hits)
}

/// Compute offline readability metrics.
#[wasm_bindgen]
pub fn analyze_readability_wasm(text: &str) -> Result<JsValue, JsValue> {
    to_js(&analyze_readability(text))
}

/// Return all built-in surface profiles from `ml/personas/surfaces.json`.
#[wasm_bindgen]
pub fn list_surfaces_wasm() -> Result<JsValue, JsValue> {
    to_js(SurfaceCatalog::shared().all())
}

/// Convert text to Chicago-style title case.
#[wasm_bindgen]
pub fn to_title_case_wasm(text: &str) -> String {
    to_title_case(text)
}

/// Convert text to sentence case outside code blocks and quotes.
#[wasm_bindgen]
pub fn to_sentence_case_wasm(text: &str) -> String {
    to_sentence_case(text)
}

/// Normalize curly quotes, ellipses, non-breaking spaces, and hidden Unicode characters.
#[wasm_bindgen]
pub fn normalize_typography_wasm(text: &str) -> Result<JsValue, JsValue> {
    to_js(&normalize_typography(text))
}
