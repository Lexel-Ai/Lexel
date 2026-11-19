# Security & Privacy Policy

## Privacy-First Security Model

Lexel is engineered around strict local-only invariants:

1. **Zero Cloud Transmission:** No draft text, grammar findings, voice examples, or telemetry leave the user's device. The browser extension Content Security Policy (`packages/lexel-browser/src/manifest.ts`) restricts `connect-src` exclusively to `'self'`, `http://127.0.0.1:*`, and `http://localhost:*`.
2. **Loopback Isolation & Authentication:**
   - The shared loopback HTTP server binds strictly to `127.0.0.1`.
   - Every `/v1/*` route requires a per-install 64-hex-char Bearer token (`daemon.token`, created with `0o600` permissions on Unix) compared in constant time.
   - A strict `Origin` middleware rejects requests from any non-loopback website.
3. **Native Messaging Primary IPC:** Chrome, Chromium, Brave, Edge, and Firefox communicate with `com.lexel.daemon` over OS-isolated stdio Native Messaging rather than exposing unauthenticated network endpoints.
4. **Secrets Guard & Privacy Blocklist:**
   - Sensitive domains (password managers, banking, payment portals, and user-configured blocklist entries) are excluded from AI rewrites and linting.
   - Password and payment inputs (`type="password"`, `autocomplete="cc-*"`) are ignored by the browser content script.
   - API keys, JWTs, private key headers, SSNs, and Luhn-valid card numbers are detected deterministically and blocked from being sent to local LLM runtimes.
5. **Verified Model Downloads:** Official GGUF artifacts declared in `models/manifest.json` are streamed to a `.part` temporary file and verified for exact byte length and SHA-256 digest before atomic rename.

## Supported Versions

Security fixes are applied to the latest `0.x` release and the `main` branch.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities (such as loopback auth bypasses, Native Messaging privilege escalation, XSS in browser overlays, or supply-chain checksum issues).

Instead, report vulnerabilities privately through [GitHub Security Advisories](https://github.com/Lexel-Ai/Lexel/security/advisories/new).

Please include:
- Affected component (`lexel-daemon`, `lexel-desktop`, `lexel-browser`, `lexel-core`, or `lexel-cli`)
- Steps to reproduce or a minimal proof of concept
- Impact assessment and suggested remediation if available

We aim to acknowledge reports within 72 hours and publish a fix and advisory promptly once verified.
