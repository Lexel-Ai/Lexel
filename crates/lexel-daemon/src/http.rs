use std::convert::Infallible;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use futures_core::Stream;
use lexel_core::UnifiedSettings;
use lexel_db::DatabaseBackup;
use serde::Deserialize;
use tokio::sync::mpsc;

use crate::auth::{constant_time_eq, is_allowed_origin};
use crate::native_messaging::{install_native_hosts, locate_daemon_binary};
use crate::service::{
    ApplyPresetRequest, BuildWeirpackRequest, CompletionRequest, CrutchWordsRequest, DaemonError,
    DaemonService, ExpandSnippetRequest, FixAllSafeRequest, ImportVoiceRequest, ReadabilityRequest,
    RedactPreviewRequest, RewriteRequest, SaveDraftRequest, SaveVoiceRequest, ScopeContextRequest,
    SynonymsRequest, Tier0CheckRequest, Tier0FixSafeRequest, TitleCaseRequest,
    ToggleCrutchWordRequest, TranscribeRequest, ValidateWeirpackRequest,
};

pub type StateChangeHook = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Clone)]
struct AppState {
    service: Arc<DaemonService>,
    token: String,
    on_change: Option<StateChangeHook>,
}

impl AppState {
    fn notify(&self, event: &str) {
        if let Some(hook) = &self.on_change {
            hook(event);
        }
    }
}

struct ChannelSseStream {
    rx: mpsc::Receiver<Result<Event, Infallible>>,
}

impl Stream for ChannelSseStream {
    type Item = Result<Event, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.rx.poll_recv(cx)
    }
}

#[derive(Debug, Deserialize)]
struct VoiceQuery {
    #[serde(rename = "surfaceId")]
    surface_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DoctorQuery {
    #[serde(default)]
    bench: bool,
}

#[derive(Debug, Deserialize)]
struct InsightsQuery {
    #[serde(default = "default_seven")]
    days: usize,
}

#[derive(Debug, Deserialize)]
struct ExportSimpoQuery {
    #[serde(rename = "surfaceId")]
    surface_id: Option<String>,
    #[serde(rename = "includeAccepted", default)]
    include_accepted: bool,
    #[serde(default = "default_simpo_limit")]
    limit: usize,
}

#[derive(Debug, Deserialize)]
struct CreateProfileBody {
    name: String,
    #[serde(rename = "cloneFromActive", default = "default_true")]
    clone_from_active: bool,
    #[serde(default = "default_true")]
    activate: bool,
}

#[derive(Debug, Deserialize)]
struct SwitchProfileBody {
    #[serde(rename = "profileId")]
    profile_id: String,
}

#[derive(Debug, Deserialize)]
struct RenameProfileBody {
    name: String,
}

#[derive(Debug, Deserialize)]
struct ToggleAiBody {
    enabled: bool,
}

#[derive(Debug, Deserialize)]
struct SetMainModelBody {
    model: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadModelBody {
    #[serde(alias = "model")]
    model_id: String,
}

fn default_true() -> bool {
    true
}

fn default_seven() -> usize {
    7
}

fn default_simpo_limit() -> usize {
    500
}

/// Build the token-authenticated, strict-Origin loopback Axum router.
pub fn build_router(service: Arc<DaemonService>, token: String) -> Router {
    build_router_with_notifier(service, token, None)
}

/// Build the loopback Axum router with an optional hook fired after any mutating state change.
pub fn build_router_with_notifier(
    service: Arc<DaemonService>,
    token: String,
    on_change: Option<StateChangeHook>,
) -> Router {
    let state = AppState {
        service,
        token,
        on_change,
    };

    let protected = Router::new()
        .route("/v1/status", get(get_status))
        .route("/v1/doctor", get(get_doctor))
        .route("/v1/profiles", get(get_profiles).post(post_profile))
        .route("/v1/profiles/switch", post(post_switch_profile))
        .route(
            "/v1/profiles/{id}",
            patch(patch_profile).delete(delete_profile),
        )
        .route(
            "/v1/settings",
            get(get_settings).put(put_settings).patch(patch_settings),
        )
        .route(
            "/v1/settings/crutch-words",
            get(get_crutch_words).put(put_crutch_words),
        )
        .route(
            "/v1/settings/crutch-words/toggle",
            post(post_toggle_crutch_word),
        )
        .route("/v1/ai/toggle", post(post_ai_toggle))
        .route("/v1/ai/main-model", post(post_ai_main_model))
        .route("/v1/ai/unload", post(post_ai_unload))
        .route("/v1/models/download", post(post_download_model))
        .route("/v1/models/{id}", delete(delete_model))
        .route("/v1/rewrite", post(post_rewrite))
        .route("/v1/rewrite/stream", post(post_rewrite_stream))
        .route("/v1/complete", post(post_complete))
        .route("/v1/context/scope", post(post_scope_context))
        .route("/v1/snippets", get(get_snippets))
        .route("/v1/snippets/expand", post(post_expand_snippet))
        .route("/v1/transcribe", post(post_transcribe))
        .route("/v1/harper/rules", get(get_harper_rules))
        .route("/v1/harper/structured-rules", get(get_structured_rules))
        .route("/v1/harper/apply-preset", post(post_harper_apply_preset))
        .route("/v1/harper/weirpack/build", post(post_weirpack_build))
        .route("/v1/harper/weirpack/validate", post(post_weirpack_validate))
        .route("/v1/tier0/check", post(post_tier0_check))
        .route("/v1/tier0/redact-preview", post(post_redact_preview))
        .route("/v1/tier0/fix-safe", post(post_tier0_fix_safe))
        .route("/v1/tier0/fix-all-safe", post(post_tier0_fix_all_safe))
        .route("/v1/tier0/title-case", post(post_tier0_title_case))
        .route("/v1/tier0/sentence-case", post(post_tier0_sentence_case))
        .route(
            "/v1/tier0/normalize-typography",
            post(post_tier0_normalize_typography),
        )
        .route("/v1/tier0/readability", post(post_tier0_readability))
        .route("/v1/tier0/synonyms", post(post_tier0_synonyms))
        .route(
            "/v1/voice-examples",
            get(get_voice_examples).post(post_voice_example),
        )
        .route("/v1/voice-examples/import", post(post_import_voice))
        .route("/v1/voice-examples/style-stats", get(get_voice_style_stats))
        .route("/v1/voice-examples/export-simpo", get(get_export_simpo))
        .route("/v1/voice-examples/{id}", delete(delete_voice_example))
        .route("/v1/analytics/stats", get(get_writing_stats))
        .route("/v1/analytics/insights", get(get_weekly_insights))
        .route("/v1/drafts", get(get_drafts).post(post_draft))
        .route("/v1/drafts/{id}", delete(delete_draft))
        .route("/v1/export", get(get_export))
        .route("/v1/import", post(post_import))
        .route("/v1/purge", post(post_purge))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            require_origin_and_bearer,
        ));

    Router::new()
        .route("/health", get(get_health))
        .route(
            "/v1/bridge/register-extension",
            post(post_register_extension),
        )
        .merge(protected)
        .layer(middleware::from_fn(cors_origin_guard))
        .with_state(state)
}

async fn cors_origin_guard(req: Request, next: Next) -> Response {
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);

    if !is_allowed_origin(origin.as_deref()) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Origin rejected by Lexel local policy." })),
        )
            .into_response();
    }

    if req.method() == Method::OPTIONS {
        let mut resp = StatusCode::NO_CONTENT.into_response();
        apply_cors_headers(resp.headers_mut(), origin.as_deref());
        return resp;
    }

    let mut resp = next.run(req).await;
    apply_cors_headers(resp.headers_mut(), origin.as_deref());
    resp
}

async fn require_origin_and_bearer(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Response {
    let auth_header = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    let provided = auth_header
        .and_then(|h| h.strip_prefix("Bearer "))
        .map(str::trim)
        .unwrap_or("");

    if !constant_time_eq(provided, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "error": "Unauthorized. Provide Authorization: Bearer <token> from `lexel-daemon token`."
            })),
        )
            .into_response();
    }

    next.run(req).await
}

fn apply_cors_headers(headers: &mut axum::http::HeaderMap, origin: Option<&str>) {
    if let Some(orig) = origin
        && let Ok(val) = HeaderValue::from_str(orig)
    {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, val);
    }
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Authorization, Content-Type"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE, OPTIONS"),
    );
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
}

impl IntoResponse for DaemonError {
    fn into_response(self) -> Response {
        let status = match &self {
            DaemonError::BadRequest(_) => StatusCode::BAD_REQUEST,
            DaemonError::PrivacyBlocked(_) => StatusCode::FORBIDDEN,
            DaemonError::Db(lexel_db::DbError::ProfileNotFound(_)) => StatusCode::NOT_FOUND,
            DaemonError::Db(lexel_db::DbError::CannotDeleteLastProfile) => StatusCode::BAD_REQUEST,
            DaemonError::Db(lexel_db::DbError::InvalidBackup(_)) => StatusCode::BAD_REQUEST,
            DaemonError::Db(lexel_db::DbError::Import(_)) => StatusCode::BAD_REQUEST,
            DaemonError::Core(_) | DaemonError::Db(_) => StatusCode::INTERNAL_SERVER_ERROR,
            DaemonError::Runtime(_) => StatusCode::SERVICE_UNAVAILABLE,
        };
        (
            status,
            Json(serde_json::json!({ "error": self.to_string() })),
        )
            .into_response()
    }
}

async fn get_health(State(state): State<AppState>) -> impl IntoResponse {
    Json(serde_json::json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "authRequired": true,
        "httpPort": state.service.http_port,
    }))
}

/// Zero-friction local browser extension pairing endpoint.
/// Accepts ONLY browser-enforced `Origin: chrome-extension://<32-char-id>` or `moz-extension://<uuid>`
/// headers and registers that extension origin in `com.lexel.daemon.json` for Native Messaging.
async fn post_register_extension(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .unwrap_or("");
    let lower = origin.to_ascii_lowercase();

    let ext_ids: Vec<String> = if let Some(rest) = lower.strip_prefix("chrome-extension://") {
        let id = rest.trim_end_matches('/');
        let valid_chrome_id = id.len() == 32 && id.bytes().all(|b| matches!(b, b'a'..=b'p'));
        if !valid_chrome_id {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({
                    "error": "Invalid chrome-extension Origin ID."
                })),
            )
                .into_response();
        }
        vec![id.to_owned()]
    } else if let Some(rest) = lower.strip_prefix("moz-extension://") {
        let id = rest.trim_end_matches('/');
        let valid_moz_id = id.len() >= 8 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-');
        if !valid_moz_id {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({
                    "error": "Invalid moz-extension Origin ID."
                })),
            )
                .into_response();
        }
        Vec::new()
    } else {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "Extension auto-registration requires a chrome-extension:// or moz-extension:// Origin."
            })),
        )
            .into_response();
    };

    let Some(daemon_bin) = locate_daemon_binary(&state.service.data_dir) else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": "Could not locate lexel-daemon binary for Native Messaging host."
            })),
        )
            .into_response();
    };

    match install_native_hosts(&daemon_bin, &state.service.data_dir, &ext_ids) {
        Ok(paths) => {
            state.notify("bridge");
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "ok": true,
                    "registeredOrigin": lower,
                    "manifestsWritten": paths.len(),
                })),
            )
                .into_response()
        }
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": format!("Failed to register Native Messaging host: {err}")
            })),
        )
            .into_response(),
    }
}

async fn get_status(State(state): State<AppState>) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.status().await?))
}

async fn get_doctor(
    State(state): State<AppState>,
    Query(query): Query<DoctorQuery>,
) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.doctor(query.bench).await?))
}

async fn get_profiles(State(state): State<AppState>) -> Result<impl IntoResponse, DaemonError> {
    let (profiles, active_profile) = state.service.list_profiles()?;
    Ok(Json(serde_json::json!({
        "profiles": profiles,
        "activeProfile": active_profile,
    })))
}

async fn post_profile(
    State(state): State<AppState>,
    Json(body): Json<CreateProfileBody>,
) -> Result<impl IntoResponse, DaemonError> {
    let profile =
        state
            .service
            .create_profile(&body.name, body.clone_from_active, body.activate)?;
    state.notify("profiles");
    Ok(Json(profile))
}

async fn post_switch_profile(
    State(state): State<AppState>,
    Json(body): Json<SwitchProfileBody>,
) -> Result<impl IntoResponse, DaemonError> {
    let profile = state.service.switch_profile(&body.profile_id)?;
    state.notify("profiles");
    Ok(Json(profile))
}

async fn patch_profile(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<RenameProfileBody>,
) -> Result<impl IntoResponse, DaemonError> {
    let profile = state.service.rename_profile(&id, &body.name)?;
    state.notify("profiles");
    Ok(Json(profile))
}

async fn delete_profile(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, DaemonError> {
    let profile = state.service.delete_profile(&id)?;
    state.notify("profiles");
    Ok(Json(profile))
}

async fn get_settings(State(state): State<AppState>) -> Result<impl IntoResponse, DaemonError> {
    let profile = state.service.active_profile()?;
    Ok(Json(serde_json::json!({
        "profile": profile,
        "settings": profile.settings,
    })))
}

async fn put_settings(
    State(state): State<AppState>,
    Json(settings): Json<UnifiedSettings>,
) -> Result<impl IntoResponse, DaemonError> {
    let profile = state.service.update_settings(&settings)?;
    state.notify("settings");
    Ok(Json(serde_json::json!({
        "profile": profile,
        "settings": profile.settings,
    })))
}

async fn patch_settings(
    State(state): State<AppState>,
    Json(patch): Json<serde_json::Value>,
) -> Result<impl IntoResponse, DaemonError> {
    let profile = state.service.patch_settings(patch)?;
    state.notify("settings");
    Ok(Json(serde_json::json!({
        "profile": profile,
        "settings": profile.settings,
    })))
}

async fn get_crutch_words(State(state): State<AppState>) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(serde_json::json!({
        "words": state.service.list_crutch_words()?
    })))
}

async fn put_crutch_words(
    State(state): State<AppState>,
    Json(body): Json<CrutchWordsRequest>,
) -> Result<impl IntoResponse, DaemonError> {
    let words = state.service.set_crutch_words(&body.words)?;
    state.notify("settings");
    Ok(Json(serde_json::json!({ "words": words })))
}

async fn post_toggle_crutch_word(
    State(state): State<AppState>,
    Json(body): Json<ToggleCrutchWordRequest>,
) -> Result<impl IntoResponse, DaemonError> {
    let words = state.service.toggle_crutch_word(&body.word, body.banned)?;
    state.notify("settings");
    Ok(Json(serde_json::json!({ "words": words })))
}

async fn post_ai_toggle(
    State(state): State<AppState>,
    Json(body): Json<ToggleAiBody>,
) -> Result<impl IntoResponse, DaemonError> {
    let res = state.service.toggle_ai(body.enabled).await?;
    state.notify("ai");
    Ok(Json(res))
}

async fn post_ai_main_model(
    State(state): State<AppState>,
    Json(body): Json<SetMainModelBody>,
) -> Result<impl IntoResponse, DaemonError> {
    let res = state.service.set_main_model(&body.model).await?;
    state.notify("ai");
    Ok(Json(res))
}

async fn post_ai_unload(State(state): State<AppState>) -> Result<impl IntoResponse, DaemonError> {
    let res = state.service.unload_ai().await?;
    state.notify("ai");
    Ok(Json(res))
}

async fn post_rewrite(
    State(state): State<AppState>,
    Json(body): Json<RewriteRequest>,
) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.rewrite(body).await?))
}

async fn post_rewrite_stream(
    State(state): State<AppState>,
    Json(body): Json<RewriteRequest>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let (tx, rx) = mpsc::channel::<Result<Event, Infallible>>(64);
    let svc = Arc::clone(&state.service);

    tokio::spawn(async move {
        let chunk_tx = tx.clone();
        let outcome = svc
            .rewrite_stream(body, move |chunk| {
                if let Ok(json) = serde_json::to_string(&chunk) {
                    let _ = chunk_tx.try_send(Ok(Event::default().event("chunk").data(json)));
                }
            })
            .await;

        match outcome {
            Ok(resp) => {
                if let Ok(json) = serde_json::to_string(&resp) {
                    let _ = tx
                        .send(Ok(Event::default().event("complete").data(json)))
                        .await;
                }
            }
            Err(err) => {
                let err_json = serde_json::json!({ "error": err.to_string() }).to_string();
                let _ = tx
                    .send(Ok(Event::default().event("error").data(err_json)))
                    .await;
            }
        }
    });

    Sse::new(ChannelSseStream { rx }).keep_alive(KeepAlive::default())
}

async fn post_complete(
    State(state): State<AppState>,
    Json(body): Json<CompletionRequest>,
) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.complete(body).await?))
}

async fn post_scope_context(
    State(state): State<AppState>,
    Json(body): Json<ScopeContextRequest>,
) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.scope_context(body)))
}

async fn post_redact_preview(
    State(state): State<AppState>,
    Json(body): Json<RedactPreviewRequest>,
) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.redact_preview(&body.text)))
}

async fn get_snippets(State(state): State<AppState>) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(serde_json::json!({
        "snippets": state.service.list_snippets()?
    })))
}

async fn post_expand_snippet(
    State(state): State<AppState>,
    Json(body): Json<ExpandSnippetRequest>,
) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.expand_snippet(body).await?))
}

async fn post_transcribe(
    State(state): State<AppState>,
    Json(body): Json<TranscribeRequest>,
) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.transcribe(body).await?))
}

async fn get_harper_rules(State(state): State<AppState>) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.harper_rules()?))
}

async fn get_structured_rules(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.structured_harper_rules()?))
}

async fn post_harper_apply_preset(
    State(state): State<AppState>,
    Json(body): Json<ApplyPresetRequest>,
) -> Result<impl IntoResponse, DaemonError> {
    let res = state.service.apply_rule_preset(&body.preset)?;
    state.notify("settings");
    Ok(Json(res))
}

async fn post_weirpack_build(
    State(state): State<AppState>,
    Json(body): Json<BuildWeirpackRequest>,
) -> Result<impl IntoResponse, DaemonError> {
    let res = state.service.build_custom_weirpack(body)?;
    state.notify("settings");
    Ok(Json(res))
}

async fn post_weirpack_validate(
    State(state): State<AppState>,
    Json(body): Json<ValidateWeirpackRequest>,
) -> Result<impl IntoResponse, DaemonError> {
    let saved = body.save;
    let res = state.service.validate_weirpack(body)?;
    if saved {
        state.notify("settings");
    }
    Ok(Json(res))
}

async fn post_tier0_check(
    State(state): State<AppState>,
    Json(body): Json<Tier0CheckRequest>,
) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.tier0_check(body)?))
}

async fn post_tier0_fix_safe(
    State(state): State<AppState>,
    Json(body): Json<Tier0FixSafeRequest>,
) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.fix_safe(body)?))
}

async fn post_tier0_fix_all_safe(
    State(state): State<AppState>,
    Json(body): Json<FixAllSafeRequest>,
) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.fix_all_safe(body)?))
}

async fn post_tier0_title_case(
    State(state): State<AppState>,
    Json(body): Json<TitleCaseRequest>,
) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(serde_json::json!({
        "text": state.service.title_case(&body.text),
    })))
}

async fn post_tier0_sentence_case(
    State(state): State<AppState>,
    Json(body): Json<TitleCaseRequest>,
) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(serde_json::json!({
        "text": state.service.sentence_case(&body.text),
    })))
}

async fn post_tier0_normalize_typography(
    State(state): State<AppState>,
    Json(body): Json<TitleCaseRequest>,
) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.normalize_typography_text(&body.text)))
}

async fn post_tier0_readability(
    State(state): State<AppState>,
    Json(body): Json<ReadabilityRequest>,
) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.readability(&body.text)))
}

async fn post_tier0_synonyms(
    State(state): State<AppState>,
    Json(body): Json<SynonymsRequest>,
) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(serde_json::json!({
        "synonyms": state.service.synonyms(&body.word),
    })))
}

async fn get_voice_examples(
    State(state): State<AppState>,
    Query(query): Query<VoiceQuery>,
) -> Result<impl IntoResponse, DaemonError> {
    let examples = state
        .service
        .list_voice_examples(query.surface_id.as_deref())?;
    Ok(Json(serde_json::json!({ "examples": examples })))
}

async fn post_voice_example(
    State(state): State<AppState>,
    Json(body): Json<SaveVoiceRequest>,
) -> Result<impl IntoResponse, DaemonError> {
    let example = state.service.save_voice_example(body)?;
    state.notify("voice");
    Ok(Json(serde_json::json!({ "example": example })))
}

async fn post_import_voice(
    State(state): State<AppState>,
    Json(body): Json<ImportVoiceRequest>,
) -> Result<impl IntoResponse, DaemonError> {
    let report = state.service.import_voice_examples(body)?;
    state.notify("voice");
    Ok(Json(report))
}

async fn get_voice_style_stats(
    State(state): State<AppState>,
    Query(query): Query<VoiceQuery>,
) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(
        state
            .service
            .voice_style_stats(query.surface_id.as_deref())?,
    ))
}

async fn get_export_simpo(
    State(state): State<AppState>,
    Query(query): Query<ExportSimpoQuery>,
) -> Result<impl IntoResponse, DaemonError> {
    let pairs = state.service.export_simpo(
        query.surface_id.as_deref(),
        query.include_accepted,
        query.limit,
    )?;
    Ok(Json(serde_json::json!({ "pairs": pairs })))
}

async fn delete_voice_example(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, DaemonError> {
    let deleted = state.service.delete_voice_example(&id)?;
    state.notify("voice");
    Ok(Json(serde_json::json!({ "deleted": deleted })))
}

async fn get_writing_stats(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.writing_stats()?))
}

async fn get_weekly_insights(
    State(state): State<AppState>,
    Query(query): Query<InsightsQuery>,
) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.weekly_insights(query.days)?))
}

async fn get_drafts(State(state): State<AppState>) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(
        serde_json::json!({ "drafts": state.service.list_drafts()? }),
    ))
}

async fn post_draft(
    State(state): State<AppState>,
    Json(body): Json<SaveDraftRequest>,
) -> Result<impl IntoResponse, DaemonError> {
    let draft = state.service.save_draft(body)?;
    state.notify("drafts");
    Ok(Json(serde_json::json!({ "draft": draft })))
}

async fn delete_draft(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, DaemonError> {
    let deleted = state.service.delete_draft(&id)?;
    state.notify("drafts");
    Ok(Json(serde_json::json!({ "deleted": deleted })))
}

async fn get_export(State(state): State<AppState>) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.export_backup()?))
}

async fn post_import(
    State(state): State<AppState>,
    Json(backup): Json<DatabaseBackup>,
) -> Result<impl IntoResponse, DaemonError> {
    let res = state.service.import_backup(backup)?;
    state.notify("backup");
    Ok(Json(res))
}

async fn post_purge(State(state): State<AppState>) -> Result<impl IntoResponse, DaemonError> {
    let res = state.service.purge_all().await?;
    state.notify("purge");
    Ok(Json(res))
}

async fn post_download_model(
    State(state): State<AppState>,
    Json(body): Json<DownloadModelBody>,
) -> Result<impl IntoResponse, DaemonError> {
    let res = state.service.download_model(&body.model_id).await?;
    state.notify("models");
    Ok(Json(res))
}

async fn delete_model(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, DaemonError> {
    let deleted = state.service.delete_model(&id).await?;
    state.notify("models");
    Ok(Json(serde_json::json!({ "deleted": deleted })))
}
