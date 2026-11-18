use std::sync::Arc;

use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use lexel_core::UnifiedSettings;
use lexel_db::DatabaseBackup;
use serde::Deserialize;

use crate::auth::{constant_time_eq, is_allowed_origin};
use crate::service::{
    ApplyPresetRequest, DaemonError, DaemonService, FixAllSafeRequest, ReadabilityRequest,
    RewriteRequest, SaveVoiceRequest, SynonymsRequest, Tier0CheckRequest, Tier0FixSafeRequest,
    TitleCaseRequest,
};

#[derive(Clone)]
struct AppState {
    service: Arc<DaemonService>,
    token: String,
}

#[derive(Debug, Deserialize)]
struct VoiceQuery {
    #[serde(rename = "surfaceId")]
    surface_id: Option<String>,
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

/// Build the token-authenticated, strict-Origin loopback Axum router.
pub fn build_router(service: Arc<DaemonService>, token: String) -> Router {
    let state = AppState { service, token };

    let protected = Router::new()
        .route("/v1/status", get(get_status))
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
        .route("/v1/ai/toggle", post(post_ai_toggle))
        .route("/v1/ai/main-model", post(post_ai_main_model))
        .route("/v1/ai/unload", post(post_ai_unload))
        .route("/v1/models/download", post(post_download_model))
        .route("/v1/rewrite", post(post_rewrite))
        .route("/v1/harper/rules", get(get_harper_rules))
        .route("/v1/harper/structured-rules", get(get_structured_rules))
        .route("/v1/harper/apply-preset", post(post_harper_apply_preset))
        .route("/v1/tier0/check", post(post_tier0_check))
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
        .route("/v1/voice-examples/{id}", delete(delete_voice_example))
        .route("/v1/export", get(get_export))
        .route("/v1/import", post(post_import))
        .route("/v1/purge", post(post_purge))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            require_origin_and_bearer,
        ));

    Router::new()
        .route("/health", get(get_health))
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

async fn get_status(State(state): State<AppState>) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.status().await?))
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
    Ok(Json(profile))
}

async fn post_switch_profile(
    State(state): State<AppState>,
    Json(body): Json<SwitchProfileBody>,
) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.switch_profile(&body.profile_id)?))
}

async fn patch_profile(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<RenameProfileBody>,
) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.rename_profile(&id, &body.name)?))
}

async fn delete_profile(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.delete_profile(&id)?))
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
    Ok(Json(serde_json::json!({
        "profile": profile,
        "settings": profile.settings,
    })))
}

async fn post_ai_toggle(
    State(state): State<AppState>,
    Json(body): Json<ToggleAiBody>,
) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.toggle_ai(body.enabled).await?))
}

async fn post_ai_main_model(
    State(state): State<AppState>,
    Json(body): Json<SetMainModelBody>,
) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.set_main_model(&body.model).await?))
}

async fn post_ai_unload(State(state): State<AppState>) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.unload_ai().await?))
}

async fn post_rewrite(
    State(state): State<AppState>,
    Json(body): Json<RewriteRequest>,
) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.rewrite(body).await?))
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
    Ok(Json(state.service.apply_rule_preset(&body.preset)?))
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
    Ok(Json(serde_json::json!({ "example": example })))
}

async fn delete_voice_example(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, DaemonError> {
    let deleted = state.service.delete_voice_example(&id)?;
    Ok(Json(serde_json::json!({ "deleted": deleted })))
}

async fn get_export(State(state): State<AppState>) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.export_backup()?))
}

async fn post_import(
    State(state): State<AppState>,
    Json(backup): Json<DatabaseBackup>,
) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.import_backup(backup)?))
}

async fn post_purge(State(state): State<AppState>) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.purge_all().await?))
}

async fn post_download_model(
    State(state): State<AppState>,
    Json(body): Json<DownloadModelBody>,
) -> Result<impl IntoResponse, DaemonError> {
    Ok(Json(state.service.download_model(&body.model_id).await?))
}
