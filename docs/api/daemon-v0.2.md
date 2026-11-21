# Lexel Local Daemon API Contract (v0.2)

Loopback HTTP base: `http://127.0.0.1:<port>` (default `42424`).
All `/v1/*` routes require `Authorization: Bearer <token>` and strict local `Origin` enforcement (same auth middleware as v0.1).
Native Messaging host: `com.lexel.daemon` (4-byte little-endian length-prefixed JSON frames over stdio).

All existing v0.1 endpoints and RPC kinds remain backwards-compatible. New fields on existing structs use `#[serde(default)]` or additive JSON keys.

---

## 1. Settings Additions (`UnifiedSettings` / `/v1/settings`)

Additive camelCase fields on `UnifiedSettings` (all defaulted for existing profiles):

```json
{
  "redactSecrets": false,
  "ghostTextEnabled": false,
  "crutchWords": ["just", "actually", "basically", "honestly"],
  "whisperModelPath": ""
}
```

- `redactSecrets` (`bool`, default `false`): Opt-in secret/PII redaction before local AI inference. When `false`, secrets hard-block AI requests (v0.1 behavior). When `true`, detected secrets/PII are swapped for `[LEXEL_REDACTED_1]` .. `[LEXEL_REDACTED_n]` before inference and restored + verified after inference.
- `ghostTextEnabled` (`bool`, default `false`): Opt-in inline ghost-text sentence completion.
- `crutchWords` (`string[]`, default `[]`): User personal crutch-word bans synced across surfaces.
- `whisperModelPath` (`string`, default `""`): Optional explicit path to a local whisper.cpp GGML model file (`.bin`); auto-discovered in `<models_dir>/whisper/` when empty.

Extended `TextSnippet` fields (backwards-compatible via defaults):

```json
{
  "trigger": "/lgtm",
  "expansion": "Looks good to me. No blocking issues.",
  "label": "PR approval",
  "surfaceId": null,
  "adaptToSurface": true,
  "category": "code-review"
}
```

---

## 2. Rewrite Enhancements (`POST /v1/rewrite`, RPC `"rewrite"` / `"aiRewrite"`)

### Supported `task` (`AiTaskId`) values
Existing (prompt byte-for-byte preserved):
- `fix_grammar_flow` ("Fix Only")
- `deslop` ("De-Slop")
- `rewrite_surface`
- `shorten` ("Shorter")
- `reply_draft`

Added tone / workflow pills:
- `direct` ("Direct")
- `softer` ("Softer")
- `bluf` ("Lead with the ask")
- `natural_english` ("Natural English")

### Request (`RewriteRequest`)
```json
{
  "text": "string (required)",
  "task": "deslop",
  "surfaceId": "github_pr",
  "subcontext": "optional string",
  "threadContext": "optional string (auto-scoped to ~300 tokens)",
  "domain": "optional hostname for privacy blocklist",
  "candidates": 1,
  "redactSecrets": null
}
```
- `candidates` (`number | null`, optional, `1` or `2`): Request `2` for "2 takes" mode (`Direct` vs `Ultra-Short`), ideal for short surfaces (`x_post`, `git_commit`, `email_subject`). Defaults to `1`.
- `redactSecrets` (`boolean | null`, optional): Per-request override for `settings.redactSecrets`.

### Response (`RewriteResponse`)
```json
{
  "original": "...",
  "suggestion": "...",
  "model": "qwen2.5:1.5b",
  "latencyMs": 420,
  "gates": {
    "zeroSlop": true,
    "numbersPreserved": true,
    "tokensPreserved": true,
    "surfaceCompliant": true,
    "grammarClean": true,
    "secretsFree": true,
    "warnings": []
  },
  "surfaceId": "github_pr",
  "subcontext": null,
  "fastPath": false,
  "retried": false,
  "failedConstraints": [],
  "candidates": [
    {
      "label": "Direct",
      "suggestion": "...",
      "gates": { "...": "..." },
      "retried": false
    }
  ],
  "redactedCount": 0,
  "restoredCleanly": true
}
```
- `fastPath`: `true` when `fix_grammar_flow` or `deslop` resolved 100% of detected issues deterministically in Tier 0 without waking the LLM (`model` is `"tier0-deterministic"`).
- `retried`: `true` when a hard Tier 2 gate failed on pass 1 and a single guided repair turn ran (capped at 15 s total).
- `failedConstraints`: Pass-1 failure reasons sent to the repair turn (empty if pass 1 succeeded).
- `candidates`: Always contains at least 1 entry (`candidates[0].suggestion === suggestion`). Contains 2 entries (`"Direct"` and `"Ultra-Short"`) when `candidates: 2` is requested.
- `redactedCount`: Number of secret/PII spans replaced with `[LEXEL_REDACTED_n]` prior to AI.
- `restoredCleanly`: `true` when all placeholders were restored cleanly (always `true` when `redactedCount === 0`).

---

## 3. Streaming Rewrite (SSE + Native Messaging Chunks)

### HTTP SSE: `POST /v1/rewrite/stream`
- Request body: identical to `RewriteRequest`.
- Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`.
- SSE events:
  1. Token chunks (0 or more):
     ```text
     event: chunk
     data: {"delta":"Fixed ","accumulated":"Fixed "}
     ```
  2. Terminal completion event (after Tier 2 verification, optional 1-retry repair, and secret restoration):
     ```text
     event: complete
     data: <RewriteResponse JSON>
     ```
  3. Terminal error event (if privacy blocked, invalid request, or runtime unavailable):
     ```text
     event: error
     data: {"error":"Local AI is turned off in Lexel Settings."}
     ```
- Note: If Tier 0 fast path resolves the request without calling the LLM, the stream emits a single `event: complete` immediately with `fastPath: true`. If secret redaction is active, streamed chunks contain `[LEXEL_REDACTED_n]` placeholders and `event: complete` delivers the restored, Tier 2-verified `RewriteResponse`.

### Native Messaging RPC: `kind: "rewriteStream"`
- Request frame:
  ```json
  { "id": "req-1", "kind": "rewriteStream", "payload": { "text": "...", "task": "deslop", "surfaceId": "slack_chat" } }
  ```
- Intermediate chunk frames (0 or more):
  ```json
  { "id": "req-1", "ok": true, "stream": true, "done": false, "data": { "delta": "We ", "accumulated": "We " } }
  ```
- Final frame (always sent once on success):
  ```json
  { "id": "req-1", "ok": true, "stream": true, "done": true, "data": { "...RewriteResponse..." } }
  ```
- Error frame (terminal):
  ```json
  { "id": "req-1", "ok": false, "stream": true, "done": true, "error": "..." }
  ```

---

## 4. Ghost-Text Sentence Autocomplete

### HTTP: `POST /v1/complete` | RPC: `"complete"` / `"ghostComplete"`
Short local inline continuation (max ~24 tokens), Tier 2 checked for slop, em dashes, and secrets.

#### Request (`CompletionRequest`)
```json
{
  "prefix": "We fixed the cache invalidation bug by ",
  "suffix": " before deploying to production.",
  "surfaceId": "github_pr",
  "subcontext": "optional string",
  "domain": "github.com",
  "maxTokens": 24
}
```
- `maxTokens`: optional, clamped to `4..=32` (default `24`).

#### Response (`CompletionResponse`)
```json
{
  "completion": "clearing stale keys on write",
  "model": "qwen2.5:0.5b",
  "latencyMs": 140,
  "gates": {
    "zeroSlop": true,
    "numbersPreserved": true,
    "tokensPreserved": true,
    "surfaceCompliant": true,
    "grammarClean": true,
    "secretsFree": true,
    "warnings": []
  }
}
```
- Returns HTTP `403` if `domain` is in `privacyBlocklist` or `prefix` contains secrets (unless `redactSecrets` is enabled).
- Returns HTTP `503` if local AI is disabled or runtime unavailable.
- If the completion fails slop/em-dash/secret checks after safe cleanup, returns `completion: ""` with the failing `gates.warnings`.

---

## 5. Smart Thread Context Scoper

### HTTP: `POST /v1/context/scope` | RPC: `"scopeThreadContext"`
Deterministically extracts the most relevant ~300 tokens of `threadContext` relative to `source`. Also applied automatically inside `POST /v1/rewrite` and `POST /v1/rewrite/stream`.

#### Request (`ScopeContextRequest`)
```json
{
  "source": "Current user draft",
  "threadContext": "Full parent thread / PR diff / email chain",
  "maxTokens": 300
}
```

#### Response (`ScopedContext`)
```json
{
  "scopedText": "...",
  "estimatedTokens": 185,
  "originalTokens": 920,
  "truncated": true,
  "keptBlocks": 3,
  "totalBlocks": 12
}
```

---

## 6. Secret Redact-and-Restore Preview

### HTTP: `POST /v1/tier0/redact-preview` | RPC: `"redactPreview"`
Deterministic zero-AI preview showing how secrets/PII in a draft would be redacted before local AI. Never logs raw text or secret values.

#### Request
```json
{ "text": "Use key AKIAIOSFODNN7EXAMPLE for staging." }
```

#### Response
```json
{
  "redactedText": "Use key [LEXEL_REDACTED_1] for staging.",
  "redactedCount": 1,
  "placeholders": [
    { "placeholder": "[LEXEL_REDACTED_1]", "kind": "aws_access_key", "label": "AWS access key ID", "maskedPreview": "AKI***(20 chars)" }
  ]
}
```

---

## 7. Context-Aware Snippets (`/standup`, `/lgtm`, `/decline`, ...)

### List Snippets
- **HTTP:** `GET /v1/snippets`
- **RPC:** `"listSnippets"`
- **Response:**
  ```json
  {
    "snippets": [
      {
        "trigger": "/standup",
        "expansion": "Yesterday:\n- ...\n\nToday:\n- ...\n\nBlockers:\n- None",
        "label": "Daily standup update",
        "surfaceId": null,
        "adaptToSurface": true,
        "category": "status",
        "builtIn": true
      }
    ]
  }
  ```

### Expand Snippet
- **HTTP:** `POST /v1/snippets/expand`
- **RPC:** `"expandSnippet"`
- **Request (`ExpandSnippetRequest`):**
  ```json
  {
    "trigger": "/lgtm",
    "surfaceId": "github_pr",
    "subcontext": "optional string",
    "threadContext": "optional parent comment or diff hunk",
    "notes": "optional user inline notes after the trigger",
    "adaptWithAi": false
  }
  ```
- **Response (`ExpandSnippetResponse`):**
  ```json
  {
    "trigger": "/lgtm",
    "rawExpansion": "...",
    "expandedText": "...",
    "surfaceId": "github_pr",
    "adaptedWithAi": false,
    "latencyMs": 1
  }
  ```
  - Deterministic placeholder expansion (`{{date}}`, `{{surface}}`, `{{subcontext}}`, `{{notes}}`) + surface register adaptation runs in <1 ms with zero AI.
  - When `adaptWithAi: true` and local AI is enabled, the daemon passes the expanded snippet + scoped `threadContext` through Tier 1 + Tier 2 for context-aware adaptation.

---

## 8. Offline Voice Transcription (`whisper.cpp`)

### HTTP: `POST /v1/transcribe` | RPC: `"transcribe"`
100% offline audio transcription via local `whisper-cli` (from `whisper.cpp`) plus optional Tier 0 cleanup and Tier 1 surface rewrite.

#### Request (`TranscribeRequest`)
```json
{
  "audioBase64": "<base64-encoded WAV/PCM audio>",
  "audioFormat": "wav",
  "language": "en",
  "surfaceId": "slack_chat",
  "subcontext": null,
  "rewriteTask": "deslop",
  "domain": null
}
```
- `audioFormat`: optional, defaults to `"wav"` (`"wav"` supported directly by `whisper-cli`).
- `language`: optional, defaults to `"en"`.
- `rewriteTask`: optional `AiTaskId`. When present and `aiEnabled` is true, runs the full rewrite pipeline (including Tier 2 verification) on the transcript for `surfaceId`.

#### Response (`TranscribeResponse`)
```json
{
  "rawTranscript": "hey so uh we fixed the cache bug in pr 42...",
  "cleanedText": "Hey, we fixed the cache bug in PR 42.",
  "rewritten": { "...RewriteResponse or null..." },
  "latencyMs": 812,
  "whisperModel": "ggml-base.en.bin"
}
```
- If `whisper-cli` or a local GGML whisper model is missing, returns HTTP `503` (or RPC `ok: false`) with a clear, actionable installation message naming the expected binary and model directory (`<models_dir>/whisper/`). Temporary audio files are deleted immediately after `whisper-cli` exits.

---

## 9. Doctor / Health Diagnostics

### HTTP: `GET /v1/doctor` (optional `?bench=true`) | RPC: `"doctor"` (optional `{"bench": true}`)

#### Response (`DoctorReport`)
```json
{
  "ok": true,
  "version": "0.1.0",
  "httpPort": 42424,
  "dataDir": "/home/user/.local/share/lexel",
  "modelsDir": "/home/user/.local/share/lexel/models",
  "runtime": {
    "activeBackend": "llama_server",
    "modelLoaded": false,
    "loadedModel": null,
    "llamaServerAvailable": true,
    "ollamaBinaryAvailable": true,
    "ollamaRunning": false,
    "ollamaModels": [],
    "lastError": null
  },
  "runtimeDetails": {
    "llamaServerPath": "/home/user/.local/share/lexel/bin/llama-server",
    "llamaServerVersion": "1.0.0-dev (build 12540)",
    "speculativeLookupSupported": true,
    "speculativeLookupFlag": "--spec-type ngram-simple",
    "cachePromptSupported": true,
    "hardwareAcceleration": "cpu"
  },
  "whisper": {
    "binaryAvailable": false,
    "binaryPath": null,
    "modelAvailable": false,
    "modelPath": null
  },
  "nativeMessaging": [
    {
      "browser": "Google Chrome",
      "manifestPath": "/home/user/.config/google-chrome/NativeMessagingHosts/com.lexel.daemon.json",
      "installed": true,
      "validJson": true,
      "hostBinaryExists": true,
      "allowedOrigins": ["chrome-extension://..."]
    }
  ],
  "models": [
    {
      "id": "lexel-1.5b",
      "ggufPath": "/home/user/.local/share/lexel/models/lexel-1.5b-q4_k_m.gguf",
      "ggufInstalled": true,
      "sizeValid": true,
      "expectedSha256": "...",
      "actualSha256": "...",
      "sha256Verified": true,
      "ollamaInstalled": false
    }
  ],
  "tier0LatencyMs": 0.45,
  "measuredTokPerSec": 18.4,
  "privacyProof": {
    "localOnlyVerified": true,
    "loopbackEnforced": true,
    "totalSecretBlocks": 3,
    "redactSecretsEnabled": false,
    "zeroTelemetry": true
  }
}
```
- `tier0LatencyMs`: Real measured duration (ms) of running the Tier 0 pipeline on a fixed sample sentence.
- `measuredTokPerSec`: Last real observed generation speed from `llama-server` / `ollama` (or `null` if no generation has run yet; if `?bench=true` and AI is active, runs a short 16-token local generation to measure live tok/s).

---

## 10. DB-Backed Insights, Voice Import, SimPO Export & Crutch Words (Wired with `lexel-db`)

These endpoints/RPCs will be wired to `devtools`'s `lexel-db` APIs once landed (returning real DB data, zero mocks):

| Feature | HTTP Route | Native Messaging RPC | Notes |
| :--- | :--- | :--- | :--- |
| Weekly Writing Insights | `GET /v1/analytics/insights?days=7` | `weeklyInsights` | Top crutch words, slop caught, grammar/conciseness trend, secret blocks (local SQLite only) |
| Voice Cold-Start Import | `POST /v1/voice-examples/import` | `importVoiceExamples` | `{ "samples": [{ "surfaceId", "text", "original?" }], "source": "paste" \| "git_log" \| "files", "repoPath?", "author?", "files?" }` |
| Voice Style Stats | `GET /v1/voice-examples/style-stats` | `voiceStyleStats` | Local voice fingerprint (`avgSentenceWords`, `directnessScore`, `emDashFreeRate`, etc.) |
| SimPO Preference Export | `GET /v1/voice-examples/export-simpo` | `exportSimpo` | PII-scrubbed JSON pairs from edited/rejected drafts (`?surfaceId=&includeAccepted=&limit=`) |
| Crutch Words | `GET /v1/settings/crutch-words`, `PUT /v1/settings/crutch-words`, `POST /v1/settings/crutch-words/toggle` | `getCrutchWords`, `setCrutchWords`, `toggleCrutchWord` | Reads/updates `crutch_word_bans` SQLite table + `UnifiedSettings.crutchWords` |

---

## 11. Extended Tier 0 Check (`POST /v1/tier0/check`, RPC `"tier0Check"`)

Backed by `lexel_core::Tier0Engine` with paragraph-hash caching.
- Optional request field: `"hasAttachmentSignal": false` (used by Regret Shield for `"see attached"`).
- Additive response fields (alongside all v0.1 fields):
  - `slopMeter`: `SlopMeterReport` (`score`, `label`, `breakdown`, `spans`)
  - `consistency`: `ConsistencyIssue[]` (mixed US/UK spelling, hyphenation, product casing, version formats)
  - `guards`: `WritingGuardHit[]` (BLUF, wall-of-text, regret shield, personal crutch words)
  - `cacheStats`: `ParagraphCacheStats` (`paragraphsTotal`, `cacheHits`, `cacheMisses`)
