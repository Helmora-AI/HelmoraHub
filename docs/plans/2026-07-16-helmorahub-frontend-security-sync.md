# HelmoraHub + Helmora-Frontend Security and Contract Sync Plan

**Status:** Implemented and verified — production deployment and migration remain owner actions
**Date:** 2026-07-16
**Repositories:** `HelmoraHub`, `Helmora-Frontend`
**Primary objective:** Make the Hub and Frontend safe to deploy together, keep their authentication contract synchronized, and close the correctness and security gaps found in the repository audit without rewriting unrelated subsystems.

## 1. Context

The current system has two independently deployed applications:

- `HelmoraHub` is the API gateway, local/remote control plane, authentication authority, and hybrid storage service.
- `Helmora-Frontend` is the React administration UI and communicates with the Hub over HTTP.

The audit established these high-priority issues:

1. A publicly bound, unconfigured Hub can be claimed by the first caller to `/api/auth/setup`.
2. The setup API returns an admin token and recovery token, but the Frontend does not preserve or show the recovery token.
3. The Frontend login/setup form can submit twice from one click.
4. The legacy settings page renders privileged values through unsafe `innerHTML` paths and Helmet protections are relaxed.
5. Unexpected server errors expose internal error messages.
6. Supabase chat append/replace operations are not atomic.
7. Tests may load the developer's real `.env` file.
8. Runtime version strings disagree with the package version.
9. Frontend strictness, test coverage, and both repositories' CI gates are incomplete.
10. Logout can leave query and chat runtime state from the previous admin session in memory.

### Audit traceability matrix

Every implementation task must first re-confirm the evidence below so a stale audit assumption is not patched blindly.

| ID | Finding and current evidence | Reproduction/evidence to capture | Task | Required regression proof |
|---|---|---|---|---|
| S-01 | Public setup takeover: `authRouter.post('/setup')` in `src/routes/auth.ts` does not require an operator bootstrap secret | Start an isolated unconfigured Hub and submit setup without a token | 1, 2A-1, 2B | Auth integration test: missing/wrong/correct token and concurrent winners |
| S-02 | Recovery handoff dropped: `setupAdmin()` in `Helmora-Frontend/src/lib/api/hub.ts` does not model `recoveryToken` | Complete setup through the current Frontend and observe immediate navigation | 5, 6 | Contract test plus browser credential-handoff evidence |
| S-03 | Double submit: `LoginPage` attaches both form `onSubmit` and button `clickAction` | One real DOM click while recording setup/login requests | 6, 16 | CDP network trace contains exactly one request |
| S-04 | Privileged DOM injection: `public/settings.html` builds API-key markup through `innerHTML` | Render a hostile API-key name/tunnel value fixture | 8, 9 | Fixture is inert text and CSP blocks inline script execution |
| S-05 | Raw internal error disclosure: the final handler in `src/app.ts` returns `err.message` | Trigger a controlled unexpected exception | 4 | Stable generic `internal_error` response |
| S-06 | Supabase append/replace race: `src/storage/chat-supabase.ts` performs multi-request mutations | Concurrent append and failed replacement simulations | 10, 11 | RPC/schema assertions and storage integration tests |
| S-07 | Real environment leakage into tests: `src/lib/config.ts` calls `loadDotenv()` at module import | Place a marker in a fake project `.env` during a config test | 12 | Marker is not loaded under `NODE_ENV=test` |
| S-08 | Runtime version drift: `src/routes/runtime.ts` contains `0.1.0` while package/runtime routes use another value | Compare package version with health, ready, admin, docs, and runtime payloads | 12 | All product-version payloads import one bundle-safe constant |
| S-09 | Incomplete logout: `logoutAdmin()` clears local chat history but not all query/mutation/runtime state | Start queries/SSE, log out, then log in again | 7 | Ordered invalidation test and browser session-isolation check |
| S-10 | Ambiguous setup delivery: current route commits config before sending one-time plaintext credentials | Inject a transport failure after commit | 1, 2A-1, 5, 6 | Password login plus admin/recovery rotation succeeds without replaying setup |
| S-11 | Auth-source precedence differs by credential type in `src/lib/admin-auth.ts`, and raw `sessionSecret` is stored in runtime config | Combine local state with environment credentials, restart with env removed, inspect stored session material | 2A-2 | Shadow/restore matrix and hash-only opaque-session assertions |
| S-12 | One global `express.json({ limit: '10mb' })` currently accepts compressed auth/control payloads before route-specific policy | Send encoded, malformed, and oversized bodies to each route class | 4 | Stable `415`/size/parser error tests and inflated-limit coverage |
| S-13 | Environment admin token can shadow a newly generated setup token, making the displayed handoff unusable | Configure only `HELMORA_ADMIN_TOKEN`, then perform first-run password setup | 2A-1, 2A-2, 2B, 5, 6 | Admin/recovery discriminated handoff and pre-setup auth-gating matrix |
| S-14 | Not copying legacy auth fields leaves raw `sessionSecret` and duplicate auth sources on disk | Migrate a populated runtime config and inject cleanup/rewrite failure | 2A-3 | Scrubbed config, consumed session file, SQLite-only restart, fail-closed partial migration |
| Q-01 | Frontend quality gate incomplete: strict mode is off, lint warnings exist, and no unified test script/CI exists | Run the current Frontend quality commands | 13, 14 | Strict build, zero-warning lint, unified tests, CI parity |

## 2. Assumptions

Implementation proceeds with these assumptions after this plan is approved:

1. Bind address, socket address, and proxy headers are not trusted indicators of whether setup is Internet-exposed.
2. The Frontend may run on a different trusted origin, including Cloudflare Pages.
3. Existing authenticated API clients must remain compatible unless they rely on an unsafe cross-origin or first-run setup behavior.
4. Server-to-server clients without an `Origin` header must continue to work.
5. Setup and recovery credentials are secrets and must never be written to logs or returned after their one-time setup response.
6. The current local SQLite and Hybrid storage behavior must remain functional.
7. Existing uncommitted documentation and task files belong to the owner and must not be overwritten.
8. No new runtime dependency will be introduced unless the existing platform cannot implement the requirement safely.

## 3. Scope

### In scope

- First-run bootstrap protection.
- Explicit browser-origin policy.
- Hub/Frontend setup, login, recovery-token, and logout synchronization.
- Authentication cache and response hardening.
- Legacy settings-page XSS and CSP hardening.
- Atomic Supabase chat mutations and their migration.
- Test isolation, version consistency, TypeScript/lint cleanup, CI, and deployment documentation.
- Automated unit/integration tests and a browser smoke test of the critical admin flow.

### Out of scope

- Redesigning authentication into a multi-user or RBAC system.
- Implementing Hybrid OAuth support that the existing design explicitly marks unsupported.
- Replacing React, Express, SQLite, Supabase, or the existing design system.
- A broad visual redesign of the Frontend.
- Refactoring large files solely to reduce their line count.
- Publishing, deploying, committing, pushing, or applying a production database migration without separate owner instruction.

## 4. Architecture decisions

### AD-1: Every unconfigured Hub requires a dedicated bootstrap secret

Add `HELMORA_SETUP_TOKEN` to the Hub configuration and require it for every unconfigured Hub, including loopback development.

- Setup policy never depends on `HOST`, `req.ip`, `socket.remoteAddress`, `Host`, or any `X-Forwarded-*` header.
- If an unconfigured Hub starts without a valid `HELMORA_SETUP_TOKEN`, the process may serve health/readiness and setup status, but setup fails closed with `503 setup_token_not_configured`.
- A missing or incorrect submitted token returns `403 setup_token_invalid`.
- There is no implicit or opt-in tokenless-local mode in this release; this removes the reverse-proxy/tunnel ambiguity entirely.
- Configuration accepts 32–512 characters as a bounded strength proxy, while documentation generates at least 32 random bytes and encodes them as hex or base64url. The application must not claim that character length alone proves entropy.
- The token is submitted only to the setup endpoint, is never persisted by the Hub, and is never echoed in a response.
- Verification hashes both configured and submitted values with SHA-256 and compares the fixed-length digests with `timingSafeEqual`.
- Setup attempts use one 15-minute window with a maximum of 10 attempts per `req.socket.remoteAddress` and 100 attempts process-wide. When setup is required and token configuration is valid, every syntactically accepted `POST /api/auth/setup` increments both counters before schema/token verification; missing/invalid environment configuration returns `503` without consuming a brute-force counter, and requests after setup return `409` without consuming it. The current supported deployment runs one Hub Node process; counters are intentionally process-local and reset on restart. They are noise/brute-force defense in depth, not a deployment-global correctness or authorization boundary. Token entropy and the SQLite CAS remain the security boundaries. Exceeding either bound returns `429 setup_rate_limited` with `Retry-After` set to the later applicable window reset. A successful setup clears all setup-limiter state.
- Neither token, request body, digest, raw malicious Origin, nor near-match diagnostic may be logged.

Invalid setup-token configuration follows one repair-friendly behavior:

- a missing, shorter-than-32, longer-than-512, or otherwise invalid `HELMORA_SETUP_TOKEN` does not crash the process;
- `/health` remains a `200` liveness response and includes a normalized, non-secret `setup_token_invalid` or `setup_token_missing` warning while the Hub is unconfigured;
- `/ready` reports not-ready while an unconfigured Hub cannot be safely set up;
- `/api/auth/status` reports `setupAvailable: false` without reflecting the configured value or its length;
- `/api/auth/setup` returns `503 setup_token_not_configured` for both missing and invalid configuration;
- once the Hub is already configured, setup-token validity does not disable normal authentication or readiness because the bootstrap secret is no longer used.

This is intentionally additive: already-configured Hubs and normal bearer-token authentication do not change.

While `setupRequired: true`, the Hub has no partially configured authentication mode:

- environment/local admin bearer tokens are not accepted for ordinary admin routes;
- recovery tokens cannot authenticate or open recovery-control routes;
- password login returns `403 setup_required` rather than authenticating an incomplete identity;
- only process liveness, readiness, public auth status, static setup UI assets, and `POST /api/auth/setup` remain operational; protected control/inference routes return the existing stable setup-required denial.

### AD-1A: Setup is an atomic local-storage compare-and-set

The current process-local `setupLock` is not the correctness boundary. Admin bootstrap state moves to a dedicated local SQLite-backed auth store under `DATA_DIR`, using the already-installed `better-sqlite3` runtime.

- A singleton row guarded by a primary-key/unique constraint represents the configured admin identity.
- One database transaction checks absence, creates the local password hash, creates hashes only for local admin/recovery tokens that are not currently environment-managed, creates distinct initial cookie/SPA opaque session hashes, and inserts the singleton/session rows.
- Only the request whose transaction inserts the singleton row receives the one-time plaintext credentials.
- A competing process/request loses the insert/CAS and receives `409 already_configured`; it never generates or returns a second credential set.
- Existing configured hashes in `runtime-config.json` are migrated through the durable cleanup state machine in AD-1C before serving auth requests. Migration never overwrites an existing singleton row and never logs credential material.
- Only an environment-managed admin password (`HELMORA_ADMIN_PASSWORD`) counts as an effective configured identity and bypasses setup; environment admin/recovery tokens alone do not.
- A process-local mutex may remain only as a load-shedding optimization, never as the atomicity guarantee.

### AD-1B: Environment auth shadows local state; new sessions are opaque

Environment-managed credentials shadow, but never delete or silently rewrite, the corresponding local credential for the lifetime of the current process:

- `HELMORA_ADMIN_PASSWORD` shadows the local password hash;
- `HELMORA_ADMIN_TOKEN` shadows the local admin-token hash;
- `HELMORA_RECOVERY_TOKEN` shadows the local recovery-token hash.

Shadowing is per credential type: when an environment value is present at process startup, only that environment value is accepted for that credential type; the shadowed local value is not accepted concurrently. Auth-source precedence is snapshotted for the process lifetime—mutating environment variables underneath a running process is unsupported. Removing the environment value and restarting restores the last local credential. Authenticated diagnostics expose only normalized source metadata (`environment`, `local`, or `none`) and `localAuthShadowed`, never hashes or values; public auth status and health do not expose credential provenance. Documentation warns operators to rotate the local credential before removing environment management when its provenance is uncertain.

| Environment value at startup | Local value | Active verifier | After env removal + restart |
|---|---|---|---|
| absent | absent | none | none |
| absent | present | local | local |
| present | absent | environment | none |
| present | present | environment only; local shadowed | local restored |

Configured/setup state is determined by an effective admin password: a local singleton password or `HELMORA_ADMIN_PASSWORD`. `HELMORA_ADMIN_TOKEN` or `HELMORA_RECOVERY_TOKEN` alone does not silently mark an otherwise unconfigured Hub as setup-complete.

During setup, an environment-managed token type does not receive a redundant local token:

- if `HELMORA_ADMIN_TOKEN` is present, setup stores no local admin-token hash and returns `adminTokenEnvManaged: true` instead of generating/displaying an unusable shadowed token;
- if `HELMORA_RECOVERY_TOKEN` is present, setup stores no local recovery-token hash and returns `recoveryTokenEnvManaged: true`;
- after the environment token is removed, the operator signs in with the local/environment password and uses the authenticated rotation endpoint to create that local token type.
- while an environment token type remains active, its rotation endpoint returns `409 admin_token_env_managed` or the existing `409 recovery_token_env_managed` and does not create a shadowed local token.

The new SQLite auth store does not persist a raw reusable signing secret. Browser-cookie and SPA sessions converge on the same opaque/hash-only storage model but use distinct random plaintext tokens per login/setup: the cookie token is delivered only through `Set-Cookie`, while the SPA bearer token is delivered only in JSON. SQLite stores only each token's SHA-256 hash, kind, creation time, and expiry. Existing hash-only SPA records in `admin-sessions.json` may be migrated. Legacy locally signed cookie sessions are invalidated once during migration, the old raw `sessionSecret` is scrubbed through AD-1C, and users sign in again. Any environment-provided legacy signing secret is neither persisted nor used to issue new opaque sessions; its legacy/deprecation behavior is documented explicitly.

Opaque-session contract:

- the session-hash column is unique; raw session tokens never enter logs or persistent storage;
- verification performs an indexed exact-hash lookup and checks kind/revocation/expiry; it never scans all sessions to authenticate one token;
- database expiry and cookie expiry represent the same instant and both are enforced; TTL defaults to the existing 86,400 seconds (24 hours), while `HELMORA_SESSION_TTL_SEC` is accepted only from 300 through 2,592,000 seconds (5 minutes–30 days);
- logout deletes/revokes every presented server-side session hash (cookie and/or bearer) before clearing the cookie; the cookie plaintext is never returned in JSON;
- logout deletes the exact presented hashes immediately; issuance/verification prunes at most 100 expired rows per request, with additional bounded maintenance passes rather than an unbounded request-time scan;
- browser state-changing requests remain subject to the canonical Origin policy even when a cookie is present;
- the production HTTPS cookie is named `__Host-helmora_sid`, with `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, no `Domain`, and matching `Max-Age`;
- local HTTP development uses the non-prefixed `helmora_sid` cookie without `Secure`, still with `HttpOnly`, `SameSite=Lax`, `Path=/`, and no `Domain`;
- secure-cookie selection is based on canonical configured deployment policy (`HELMORA_PUBLIC_URL`/explicit cookie configuration), never an untrusted forwarded header; migration/logout clear both legacy and current cookie names.

### AD-1C: Legacy auth migration is durable and removes old secret material

Migration uses an explicit SQLite metadata version and phase; after SQLite migration begins, runtime never merges or authenticates against both old files and the new store.

1. Read legacy auth data once and validate it without logging material.
2. In one SQLite transaction, import the singleton and valid hash-only opaque sessions, set `authStoreMigrationVersion = 1`, and mark phase `legacy_cleanup_required`.
3. Read back and validate the SQLite rows.
4. Atomically rewrite `runtime-config.json` through temp-file, file sync, and rename with `authStoreMigrationVersion: 1` but without migrated password/admin/recovery hashes, raw `sessionSecret`, or obsolete session metadata.
5. Atomically rename `admin-sessions.json` to a consumed-v1 name; signed-cookie sessions are never imported, runtime never reads the consumed name, and deletion after verification is best effort because the file contains hashes rather than reusable plaintext.
6. Mark the SQLite migration phase `complete`. From that point onward, runtime permanently ignores legacy auth fields even if an old file reappears.

If SQLite commit succeeds but config/session-file cleanup fails, startup exposes normalized `auth_migration_incomplete`, keeps `/health` live, keeps `/ready` not-ready, and refuses setup/login/recovery/session issuance until cleanup can resume. It never falls back to legacy auth, never issues from two stores, and never silently marks the migration complete. A runtime marker claiming version 1 while the SQLite store is missing/corrupt is also a fail-closed durability error, not a legacy fallback signal.

### AD-2: Browser origins are explicit; non-browser API clients remain supported

Allowed origins are assembled only from canonical operator configuration:

- `HELMORA_PUBLIC_URL` for the Hub-hosted browser UI;
- `HELMORA_FRONTEND_URL` for the primary separate SPA;
- the comma-separated `HELMORA_CORS_ORIGINS` list for additional trusted SPAs.

Rules:

- No origin is inferred from `Host`, `X-Forwarded-Host`, `Forwarded`, socket addresses, or any other request metadata.
- Requests without `Origin` are treated as server-to-server and are not blocked by the browser-origin policy.
- A request with an unapproved `Origin` receives `403 origin_not_allowed`.
- Preflight uses the same decision function as actual requests.
- Cross-origin Frontend authentication uses `Authorization: Bearer`; therefore CORS uses `credentials: false` and never emits `Access-Control-Allow-Credentials`.
- Allowed responses echo only the exact normalized configured origin and include `Vary: Origin`.
- Configuration is rejected for wildcard `*`, credentials in URL, non-root path, query, fragment, `Origin: null`, non-HTTP(S) schemes, trailing-dot hostname ambiguity, hostname patterns, or malformed list entries.
- Normalization uses the URL parser and compares `scheme + normalized hostname + normalized explicit/default port`; substring and suffix matching are forbidden.

### AD-3: Setup credentials use an explicit one-time handoff

The setup response remains additive and uses independent discriminated handoffs for both long-lived token types:

```typescript
type SetupAdminCredential =
  | { adminToken: string; adminTokenEnvManaged?: never }
  | { adminToken?: never; adminTokenEnvManaged: true };

type SetupRecoveryCredential =
  | { recoveryToken: string; recoveryTokenEnvManaged?: never }
  | { recoveryToken?: never; recoveryTokenEnvManaged: true };

type SetupHandoff = {
  ok: true;
  token: string;
  expiresAt: string;
} & SetupAdminCredential & SetupRecoveryCredential;
```

The mutually exclusive environment-managed variant never generates, stores, or displays a local token that cannot authenticate in the current process.

After successful setup, the Frontend must not immediately persist the SPA session or navigate away. It holds a dedicated, non-persisted `SetupHandoff` in component/auth-flow memory, outside React Query and mutation caches, URL/router state, `localStorage`, `sessionStorage`, analytics, and telemetry.

After explicit acknowledgment:

- only the short-lived SPA `token` and `expiresAt` move to the existing `sessionStorage` session contract;
- generated admin/recovery credentials and the submitted setup token are cleared from component memory;
- browser history is replaced so Back cannot reveal the handoff again;
- copy-success UI appears only after the Clipboard API actually resolves.

### AD-3A: Ambiguous setup success recovers through password login and rotation

This release deliberately does not persist a replayable setup-delivery envelope or accept an `Idempotency-Key`. That design would retain recoverable admin/recovery plaintext beyond the response and add acknowledgment/expiry/key-management state.

If the atomic setup transaction commits but the response is lost because the connection drops or the process exits:

1. the Hub remains configured and a retry with any setup request receives `409 already_configured`;
2. the Frontend treats a setup transport failure as ambiguous and refetches `/api/auth/status`;
3. when status now reports `setupRequired: false`, the UI explains that setup may have succeeded and switches to password login without claiming the credentials were delivered;
4. the operator signs in with the password just chosen;
5. the authenticated operator rotates whichever non-environment-managed local token credentials were generated but not delivered; environment-managed variants remain operator-owned and are not regenerated. These rotation responses use the same one-time/no-store handling as setup.

The integration matrix injects a response-transport failure after the store commit and proves password login plus rotation succeeds for each locally generated token type. For an environment-managed type, it proves no local token was generated/lost and the corresponding normalized `*_token_env_managed` rotation response is returned.

### AD-4: Error responses are stable contracts

Expected errors use a stable body:

```json
{
  "error": {
    "type": "setup_token_invalid",
    "message": "Setup token is invalid."
  }
}
```

The existing `error.type` field remains the machine-readable identifier because current Hub and Frontend consumers already depend on it. This release does not replace it with a new `code` field.

Unexpected failures return `500 internal_error` with a generic public message. Detailed errors may be logged server-side only after secret-bearing fields are redacted. Secret-bearing auth responses include `Cache-Control: no-store`, `Pragma: no-cache`, and `Referrer-Policy: no-referrer`.

### AD-4A: Auth/control bodies do not accept content encoding

- `/api/auth` JSON is limited to `16 KiB` and normal `/api` control JSON to `256 KiB`; both parsers use `inflate: false`.
- Any auth/control request with a non-identity `Content-Encoding` is rejected before authentication/business logic with `415 unsupported_content_encoding`.
- `/api/chat` and `/v1` retain their documented `10 MiB` vision/chat capability; when compression is accepted there, the limit applies to inflated bytes.
- Parsers are mounted per route class before the corresponding router. No earlier global `10mb` parser may consume the body and bypass a smaller downstream limit.

### AD-5: Supabase mutations own their transaction inside PostgreSQL

Client-side sequences of `select -> insert` and `delete -> insert` cannot provide atomicity through separate PostgREST requests. PostgreSQL RPC functions will therefore own the transaction and lock the target chat session row.

- The target session must already exist; missing sessions return normalized `chat_session_not_found` and are never created implicitly.
- `(session_id, seq)` receives a unique constraint/index.
- `append_chat_message_atomic` locks the session row, calculates the next sequence, and inserts in one transaction.
- `replace_chat_messages_atomic` validates role, message count, per-message size, total payload size, preserved IDs/timestamps, and session existence before delete; sequence is generated server-side.
- The migration runs a duplicate preflight and fails with remediation guidance; it never deletes or renumbers existing data automatically.
- Function execution is revoked from `PUBLIC`, `anon`, and `authenticated`, and granted only to `service_role`.
- Functions use invoker rights where possible. Any required `SECURITY DEFINER` function has a fixed owner, `SET search_path = ''`, schema-qualified objects, and no dynamic SQL.

### AD-6: Each repository owns its version source

- Hub runtime endpoints derive their version from the Hub package metadata rather than hardcoded strings.
- Frontend package/versioning remains independently releasable; synchronization means API-contract compatibility, not forcing unrelated packages to share a release number.

## 5. API contract

### `GET /api/auth/status`

Additive response fields:

```json
{
  "setupRequired": true,
  "authenticated": false,
  "setupTokenRequired": true,
  "setupAvailable": false,
  "setupUnavailableReason": "setup_token_not_configured"
}
```

Requirements:

- Never reveal whether a submitted token is close to or equal to the configured value.
- Apply `Cache-Control: no-store`.
- Existing `setupRequired` and `authenticated` fields remain authoritative and backward compatible; no redundant `configured` field is required.
- `setupTokenRequired` is `true` for every unconfigured Hub and `false` after setup is complete.
- `setupAvailable` is `false` when the required environment configuration is missing/invalid; `setupUnavailableReason` is absent when setup is available or no longer required.
- Public status never exposes whether password/admin/recovery credentials come from environment or local storage. Existing provenance/capability fields such as `envPassword`, `envAdminToken`, `hasAdminToken`, and `recoveryAvailable` move to authenticated diagnostics and are omitted from the public response. This is an intentional security-contract change: any diagnostic consumer must authenticate and use `/api/auth/me`.

### Authenticated `GET /api/auth/me` diagnostics

When and only when the request is already authenticated, `/api/auth/me` adds:

```json
{
  "authSources": {
    "password": "environment",
    "adminToken": "local",
    "recoveryToken": "none"
  },
  "localAuthShadowed": true,
  "authStoreMigrationVersion": 1
}
```

These fields contain no hashes, values, token lengths, or setup-token metadata. Unauthenticated requests receive the normal authentication denial and no source diagnostics.

### `GET /health` and `GET /ready` during bootstrap misconfiguration

- `/health` remains `200` for process liveness and adds a normalized warning array containing `setup_token_missing` or `setup_token_invalid` only while setup is required.
- `/ready` returns `503` with stable `setup_unavailable` while setup is required but unavailable.
- An incomplete auth-store cleanup similarly keeps health live with `auth_migration_incomplete`, readiness unavailable, and all credential-using routes fail closed until the migration resumes successfully.
- `/api/auth/status` remains `200` so the operator UI can explain and repair configuration.
- Missing and weak/invalid setup-token configuration follow this same behavior; neither route exposes the value, length, digest, or validation detail.

### `POST /api/auth/setup`

Request:

```json
{
  "password": "chosen admin password",
  "setupToken": "required for every unconfigured Hub"
}
```

Response codes:

| Status | Code | Meaning |
|---|---|---|
| `200` | success | Hub configured; one-time credentials returned |
| `400` | `validation_error` | Body does not match the setup schema |
| `403` | `setup_token_invalid` | The required setup token is missing or wrong |
| `409` | `already_configured` | Hub was already configured |
| `429` | `setup_rate_limited` | Process-wide or per-socket-source attempt bound was exceeded |
| `503` | `setup_token_not_configured` | The operator did not configure a valid bootstrap secret |

Successful fully local handoff:

```json
{
  "ok": true,
  "token": "short-lived-spa-session",
  "expiresAt": "2026-07-16T01:00:00.000Z",
  "adminToken": "long-lived-admin-token",
  "recoveryToken": "one-time-recovery-token"
}
```

Successful environment-managed admin-token variant:

```json
{
  "ok": true,
  "token": "short-lived-spa-session",
  "expiresAt": "2026-07-16T01:00:00.000Z",
  "adminTokenEnvManaged": true,
  "recoveryToken": "one-time-recovery-token"
}
```

Admin and recovery variants are independently mutually exclusive. When a token type is environment-managed, its plaintext field and local hash are both absent. The Frontend validates all four legal combinations and rejects responses containing both/neither field for either discriminator.

Requirements:

- Apply `Cache-Control: no-store`, `Pragma: no-cache`, and `Referrer-Policy: no-referrer`.
- Enforce a bounded password and token length.
- Never include the setup token in responses or logs.
- Preserve single-winner behavior when two setup requests race.
- While setup is required, environment admin/recovery tokens cannot authenticate ordinary or recovery routes.
- A committed setup is never rolled back merely because response delivery fails; recovery follows AD-3A.

### Authenticated token rotation under environment management

- `POST /api/auth/rotate-token` returns `409 admin_token_env_managed` and no plaintext/local hash while `HELMORA_ADMIN_TOKEN` is active.
- `POST /api/auth/rotate-recovery-token` retains `409 recovery_token_env_managed` while `HELMORA_RECOVERY_TOKEN` is active.
- After the environment token is removed and the Hub restarts, password authentication can create the missing local token through the same rotation endpoint.
- Successful rotation is a one-time secret response with the same no-store/referrer/clipboard handling as setup.

## 6. Implementation plan

Tasks are dependency-ordered and executed sequentially. Every task must leave its repository buildable. No implementation task starts until this plan is approved.

### Task 1: Re-confirm audit evidence and add failing bootstrap-policy tests

**Description:** Lock the current green baseline and express the mandatory bootstrap-token behavior across loopback, public, and proxied deployments before production code changes.

**Likely files:**

- `HelmoraHub/src/__tests__/admin-auth.test.ts`
- `HelmoraHub/src/__tests__/test-request.ts` or the existing request helper, if needed

**Acceptance criteria:**

- Every unconfigured Hub without an environment setup token is tested as fail-closed, including a loopback listener behind a simulated proxy/tunnel.
- Missing/wrong/correct submitted tokens are covered.
- `Host`, `Forwarded`, `X-Forwarded-*`, `req.ip`, and socket-address variations cannot waive the token requirement.
- Concurrent requests/process-like store instances prove exactly one winner.
- A post-commit response failure proves the Hub remains configured and the password-authenticated rotation recovery path works.
- The audit traceability evidence is refreshed against current symbols before fixes begin.

**Verification:**

```powershell
npm test -- --run src/__tests__/admin-auth.test.ts
```

**Dependencies:** None.

### Task 2A-1: Implement atomic admin bootstrap persistence

**Description:** Replace the process-local setup lock as the correctness boundary with a SQLite singleton-row compare-and-set transaction that remains correct across concurrent Hub processes.

**Likely files:**

- `HelmoraHub/src/lib/admin-auth-store.ts` (new)
- `HelmoraHub/src/lib/runtime-config.ts`
- `HelmoraHub/src/lib/admin-auth.ts`
- `HelmoraHub/src/routes/auth.ts`
- `HelmoraHub/src/__tests__/admin-auth-store.test.ts` (new)

**Acceptance criteria:**

- Bootstrap creation is one transaction containing the configured check, local password, distinct initial cookie/SPA opaque session hashes, and only those local admin/recovery token hashes not currently environment-managed.
- The singleton constraint/CAS selects one winner; losing callers receive `already_configured` and no plaintext credentials.
- An environment-managed admin/recovery token type produces the matching `*TokenEnvManaged: true` discriminator and no redundant local token/hash.
- A process-local mutex is not required for correctness.

**Verification:**

```powershell
npm test -- --run src/__tests__/admin-auth-store.test.ts src/__tests__/admin-auth.test.ts
npm run typecheck
```

**Dependencies:** Task 1.

### Task 2A-2: Lock environment precedence and opaque session persistence

**Description:** Apply the per-credential environment-shadowing contract and converge browser-cookie/SPA authentication on hash-only opaque sessions.

**Likely files:**

- `HelmoraHub/src/lib/admin-auth-store.ts`
- `HelmoraHub/src/lib/admin-auth.ts`
- `HelmoraHub/src/lib/admin-sessions.ts`
- `HelmoraHub/src/routes/auth.ts`
- `HelmoraHub/src/__tests__/admin-auth-precedence.test.ts` (new)

**Acceptance criteria:**

- Environment-managed password/admin/recovery credentials shadow their corresponding local values per AD-1B; shadowed local credentials are not concurrently accepted.
- Removing environment management and restarting restores unchanged local state according to the documented policy.
- Auth-source/shadow metadata is available only through authenticated `/api/auth/me`, without exposing hashes or values; public status omits it.
- While setup is required, admin/recovery environment tokens cannot authenticate ordinary/recovery routes.
- New cookie/SPA sessions use distinct plaintext tokens and store only unique hashes plus kind/expiry; the cookie token never appears in JSON, default/configured TTL matches cookie expiry, and request-time expired-row pruning is capped at 100.
- Production/local cookie names and `HttpOnly`/`Secure`/`SameSite=Lax`/`Path=/`/no-`Domain` attributes follow AD-1B; logout revokes the database hash and clears current/legacy cookies.
- Admin/recovery rotation returns the normalized env-managed `409` and creates no local token while that environment type is active; after env removal/restart, authenticated rotation can create the missing local token. Password updates target local state predictably while an environment password continues to shadow verification.

**Verification:**

```powershell
npm test -- --run src/__tests__/admin-auth-precedence.test.ts src/__tests__/admin-auth-store.test.ts src/__tests__/admin-auth.test.ts
npm run typecheck
```

**Dependencies:** Task 2A-1.

### Task 2A-3: Scrub legacy auth files with a durable migration state machine

**Description:** Migrate existing local auth/session state once, remove raw and duplicate legacy material from disk, and fail closed across partial cleanup failures.

**Likely files:**

- `HelmoraHub/src/lib/admin-auth-store.ts`
- `HelmoraHub/src/lib/runtime-config.ts`
- `HelmoraHub/src/lib/admin-sessions.ts`
- `HelmoraHub/src/app.ts`
- `HelmoraHub/src/__tests__/admin-auth-migration.test.ts` (new)

**Acceptance criteria:**

- SQLite records migration version/phase before legacy cleanup; readback is validated before file mutation.
- Atomic runtime-config rewrite removes migrated password/token hashes, raw `sessionSecret`, and obsolete session metadata while retaining unrelated owner settings and a version-1 consumption marker.
- Valid opaque session hashes migrate once; signed-cookie sessions do not. The legacy session file is atomically marked consumed and no longer read.
- Restart after completion reads SQLite only and rejects old signed cookies.
- Injected config/session cleanup failure produces `auth_migration_incomplete`, live health, not-ready readiness, and no setup/login/recovery/session issuance from either store; restart safely resumes cleanup.
- A version marker with missing/corrupt SQLite state fails closed instead of falling back to legacy auth.

**Verification:**

```powershell
npm test -- --run src/__tests__/admin-auth-migration.test.ts src/__tests__/admin-auth-store.test.ts src/__tests__/admin-auth-precedence.test.ts
npm run typecheck
```

**Dependencies:** Task 2A-2.

### Task 2B: Implement bootstrap-token validation, rate limiting, and setup contract

**Description:** Require a strong operator bootstrap token for every unconfigured Hub, validate configuration at the boundary, and add stable setup-specific throttling and errors.

**Likely files:**

- `HelmoraHub/src/lib/config.ts`
- `HelmoraHub/src/lib/setup-token.ts` (new)
- `HelmoraHub/src/routes/auth.ts`
- `HelmoraHub/src/__tests__/admin-auth.test.ts`

**Acceptance criteria:**

- First-run setup cannot succeed without the configured bootstrap token, regardless of listener or proxy metadata.
- Config classifies tokens outside the 32–512-character bound as invalid without crashing; an unconfigured Hub remains live but not ready/setup-capable, and setup returns the same `503 setup_token_not_configured` used for missing configuration.
- Both values are SHA-256 digested before fixed-length timing-safe comparison.
- Setup limiting uses 10 attempts per socket source and 100 process-wide per 15 minutes, counts each parsed setup request only when setup/token configuration is available, returns the later reset through `Retry-After`, is explicitly process-local, and never uses proxy headers for the source key; success clears limiter state while pre-config `503` and post-config `409` do not consume counters.
- Correct-token setup returns independent admin/recovery discriminators and never creates a local token hash for an environment-managed token type.
- The token is absent from persisted configuration, response bodies, and error messages.
- Logs contain no request bodies, token/digest values, raw malicious origins, or near-match diagnostics.
- Tests prove missing/weak configuration behavior is consistent across liveness, readiness, auth status, and setup.
- Tests prove env admin/recovery tokens cannot bypass `setupRequired: true`.

**Verification:**

```powershell
npm test -- --run src/__tests__/admin-auth.test.ts src/__tests__/recovery-auth.test.ts
npm run typecheck
```

**Dependencies:** Task 2A-3.

### Task 3: Add and test the explicit browser-origin policy

**Description:** Replace permissive global CORS behavior with one normalized origin-decision function shared by preflight and actual requests.

**Likely files:**

- `HelmoraHub/src/app.ts`
- `HelmoraHub/src/lib/config.ts`
- `HelmoraHub/src/lib/origin-policy.ts` (new)
- `HelmoraHub/src/__tests__/origin-policy.test.ts` (new)

**Acceptance criteria:**

- Canonical `HELMORA_PUBLIC_URL`, `HELMORA_FRONTEND_URL`, and additional configured Frontend origins work.
- Unapproved browser origins receive `403 origin_not_allowed`.
- Requests without `Origin` continue to work.
- No allow decision reads `Host`, `Forwarded`, or `X-Forwarded-*`.
- CORS uses exact origin, `credentials: false`, no `Access-Control-Allow-Credentials`, and `Vary: Origin`.
- Tests cover suffix attacks, userinfo (`trusted.example@attacker.test`), non-root path, trailing-dot host, scheme downgrade, `Origin: null`, mixed-case host, default-vs-explicit port, IPv6 forms, wildcard, and multiple malformed env entries.
- The stable error body never reflects the raw malicious Origin.

**Verification:**

```powershell
npm test -- --run src/__tests__/origin-policy.test.ts
npm run typecheck
```

**Dependencies:** Task 2B.

### Task 4: Harden request limits, auth caching, and public errors

**Description:** Bound request sizes by route class, prevent credential responses from being cached, and stop exposing raw unexpected exception messages.

**Likely files:**

- `HelmoraHub/src/app.ts`
- `HelmoraHub/src/routes/auth.ts`
- `HelmoraHub/src/__tests__/app-security.test.ts` (new)

**Acceptance criteria:**

- Route parsers are mounted before their routers with no earlier global large JSON parser: auth `16 KiB`, normal control JSON `256 KiB`, and existing chat/vision routes `10 MiB`.
- Auth and normal control JSON parsers use `inflate: false`; any non-identity `Content-Encoding` receives stable `415 unsupported_content_encoding` before authentication/business logic.
- Chat/vision keep their documented compression behavior, with the `10 MiB` limit enforced against inflated bytes.
- Oversized, malformed JSON, unsupported compression, and inflated-size behavior is covered without leaking parser internals.
- Auth status, setup, login, recovery, admin-token rotation, and recovery-token rotation responses use `Cache-Control: no-store`; secret-bearing responses also use `Pragma: no-cache` and `Referrer-Policy: no-referrer`.
- Unexpected errors expose only `internal_error` while operational errors retain useful stable `error.type` identifiers.

**Verification:**

```powershell
npm test -- --run src/__tests__/app-security.test.ts src/__tests__/admin-auth.test.ts
npm run typecheck
npm run build
```

**Dependencies:** Task 3.

### Checkpoint A: Hub perimeter

- Full Hub tests pass.
- Hub typecheck and build pass.
- Existing authenticated server-to-server requests still work.
- First-run takeover across loopback, public, and proxied deployments plus arbitrary browser-origin access are blocked.

### Task 5: Synchronize the Frontend API client with the setup contract

**Description:** Parse the additive status/setup fields and represent the one-time credential result explicitly.

**Likely files:**

- `Helmora-Frontend/src/lib/api/hub.ts`
- `Helmora-Frontend/src/lib/api/auth-contract.ts` (new, only if it keeps schemas focused)
- `Helmora-Frontend/tests/auth-contract.test.ts` (new)
- `Helmora-Frontend/package.json`

**Acceptance criteria:**

- Status exposes `setupTokenRequired` with a backward-compatible default.
- Setup returns a validated handoff containing the short-lived SPA session plus independent mutually exclusive admin/recovery generated-vs-environment-managed discriminators; all four legal combinations are tested.
- Malformed credential responses are rejected instead of silently navigating forward.
- The API client is pure for setup: it does not write the session or place the response in React Query/mutation caches.
- Setup transport failure is represented separately from a confirmed API rejection so the UI can refetch status and enter the AD-3A ambiguous-success recovery path.
- A single `npm test` command runs all Frontend tests.

**Verification:**

```powershell
npm test
npm run build
```

**Dependencies:** Task 2B.

### Task 6: Fix setup/login submission and one-time credential UX

**Description:** Remove the double-submit path, add a single-flight guard, request the mandatory bootstrap token during setup, and hold session persistence/navigation until credentials are acknowledged.

**Likely files:**

- `Helmora-Frontend/src/features/auth/LoginPage.tsx`
- `Helmora-Frontend/src/features/auth/auth-submit.ts` (new, if needed for testability)
- `Helmora-Frontend/tests/auth-submit.test.ts` (new)
- `Helmora-Frontend/src/app/AppShell.css` or the smallest existing auth stylesheet

**Acceptance criteria:**

- One button click or Enter action produces at most one active setup/login request.
- Every unconfigured Hub asks for the setup token; listener address does not change the form contract.
- Each generated admin/recovery credential is visible and individually copyable exactly after setup; each environment-managed type is represented without generating or echoing a local token.
- Navigation requires an explicit "I saved these credentials" action.
- The handoff lives only in local component/auth-flow memory, not React Query, mutation cache, URL/router state, local/session storage, analytics, telemetry, or console output.
- Clipboard success is shown only after the write resolves; failure remains visible and does not claim success.
- On acknowledgment, only the short-lived SPA session is persisted; credential/setup-token state is zeroed and navigation replaces browser history.
- If setup transport fails and refreshed status is configured, the UI does not retry setup or claim failure/success; it explains the ambiguous commit, switches to password sign-in, and directs the authenticated operator to rotate whichever local token types were not environment-managed.
- Admin-token and recovery-token rotation results receive the same transient one-time display, clipboard, cache, and response-header treatment as initial setup.

**Verification:**

```powershell
npm test
npm run lint
npm run build
```

**Dependencies:** Task 5.

### Task 7: Clear all authenticated client state on logout/session invalidation

**Description:** Make logout terminate the entire local admin session, including server-state caches and the chat runtime singleton.

**Likely files:**

- `Helmora-Frontend/src/lib/api/sessionInvalidation.ts`
- `Helmora-Frontend/src/lib/chatRuntime.ts`
- `Helmora-Frontend/src/app/AppShell.tsx`
- `Helmora-Frontend/tests/session-invalidation.test.ts`

**Acceptance criteria:**

- Session invalidation is marked before teardown begins so new authenticated work cannot start.
- Active chat/SSE generation is aborted, then in-flight queries and mutations are cancelled.
- Server logout/revocation is best effort with the current token; local cleanup always runs in `finally`.
- Query and mutation caches are cleared; chat runtime controllers, event listeners, subscriptions, and singleton readiness state are reset.
- Credentials are removed only after best-effort revocation, then navigation replaces history.
- Logging in again cannot display state from the prior session.
- Logout remains safe and idempotent when invoked twice.

**Verification:**

```powershell
npm test
npm run lint
npm run build
```

**Dependencies:** Task 6.

### Checkpoint B: Auth flow end to end

- Hub and Frontend contract tests pass.
- Setup, credential acknowledgment, login, logout, and login-again flows work together.
- One user action creates one network request.

### Task 8: Remove unsafe legacy settings rendering

**Description:** Replace privileged-value `innerHTML` construction with DOM/text-safe rendering and make the legacy setup flow preserve generated one-time credentials or clearly represent environment-managed admin/recovery types.

**Likely files:**

- `HelmoraHub/public/settings.html`
- `HelmoraHub/src/__tests__/legacy-settings-security.test.ts` (new)

**Acceptance criteria:**

- API key names, IDs, tunnel URLs, and server-provided messages are inserted as text, not executable markup.
- The legacy setup flow shows each generated admin/recovery token with an explicit save acknowledgment, or the corresponding environment-managed notice without echoing its value.
- A regression fixture containing HTML/script payloads is rendered inert.

**Verification:**

```powershell
npm test -- --run src/__tests__/legacy-settings-security.test.ts
npm run build
```

**Dependencies:** Task 4.

### Task 9: Restore Helmet protections with a static-page CSP

**Description:** Move legacy inline assets to static files where necessary and enable a CSP that does not require broad script execution permissions.

**Likely files:**

- `HelmoraHub/public/settings.html`
- `HelmoraHub/public/settings.js` (new)
- `HelmoraHub/public/settings.css` (new)
- `HelmoraHub/src/app.ts`
- `HelmoraHub/src/__tests__/app-security.test.ts`

**Acceptance criteria:**

- Helmet CSP and HSTS are not globally disabled.
- `script-src` does not require `unsafe-eval`; inline scripts are removed or tightly handled.
- The legacy settings page still loads and performs its existing authenticated operations.
- Frame, object, base, and form destinations are restricted.

**Verification:**

```powershell
npm test -- --run src/__tests__/app-security.test.ts src/__tests__/legacy-settings-security.test.ts
npm run build
```

**Dependencies:** Task 8.

### Task 10: Add atomic Supabase chat operations to schema and migration

**Description:** Introduce the database constraints and service-role-only RPC functions required for transactional chat mutations.

**Likely files:**

- `HelmoraHub/sql/supabase-schema.sql`
- `HelmoraHub/sql/migrations/005_atomic_chat_messages.sql` (new)
- `HelmoraHub/sql/migrations/README.md`
- `HelmoraHub/src/__tests__/supabase-schema.test.ts`

**Acceptance criteria:**

- `(session_id, seq)` uniqueness is enforced.
- Append and replace RPCs require and lock an existing target session, complete atomically, and return normalized `chat_session_not_found` when absent.
- Replacement validates role, count, individual content size, total payload, preserved IDs/timestamps, and all other invariants before `DELETE`; sequence is generated server-side.
- Duplicate preflight aborts with remediation guidance and never silently deletes or renumbers data.
- Schema tests assert exact `REVOKE ALL ON FUNCTION ... FROM PUBLIC/anon/authenticated` and `GRANT EXECUTE ... TO service_role` statements.
- Any `SECURITY DEFINER` use has a fixed owner, empty search path, schema-qualified objects, and no dynamic SQL.
- The canonical schema and incremental migration describe the same final state.

**Verification:**

```powershell
npm test -- --run src/__tests__/supabase-schema.test.ts
```

**Dependencies:** None for authoring; must be complete before Task 11.

### Task 11: Route Supabase chat storage through the atomic RPCs

**Description:** Replace multi-request append/replace/import implementations with the transaction-owning database functions.

**Likely files:**

- `HelmoraHub/src/storage/chat-supabase.ts`
- `HelmoraHub/src/__tests__/chat-supabase.test.ts` (new or existing equivalent)
- `HelmoraHub/src/lib/supabase-schema.ts`, only if runtime capability checks require the new functions

**Acceptance criteria:**

- Append does not calculate `MAX(seq) + 1` in application code.
- Replace/import cannot leave a session empty after a failed insertion.
- RPC failures are checked and surfaced through the existing storage error model.
- Missing-session errors are normalized and never cause an implicit session creation.
- SQLite and Hybrid-local chat behavior remains unchanged.

**Verification:**

```powershell
npm test -- --run src/__tests__/chat-supabase.test.ts src/__tests__/supabase-schema.test.ts
npm run typecheck
```

**Dependencies:** Task 10.

### Checkpoint C: Legacy UI and storage integrity

- Legacy settings page passes security regression checks.
- CSP headers are present and the page remains functional.
- Supabase schema tests prove atomic functions and least-privilege grants exist.
- Hub storage tests pass for Supabase, Hybrid, and SQLite paths.

### Task 12: Isolate test environment and centralize Hub runtime version

**Description:** Prevent tests from loading local secrets and remove drift between package and runtime endpoint versions.

**Likely files:**

- `HelmoraHub/src/lib/config.ts`
- `HelmoraHub/src/lib/version.ts` (new)
- `HelmoraHub/src/app.ts`
- `HelmoraHub/src/routes/runtime.ts`
- `HelmoraHub/src/__tests__/config-isolation.test.ts` and the current health/runtime tests

**Acceptance criteria:**

- Config calls dotenv only when `NODE_ENV !== 'test'`; Vitest establishes `NODE_ENV=test` before importing application config.
- Tests use disposable SQLite/data paths, restore environment changes, and cannot inherit tunnel/Supabase production values accidentally.
- A negative test places a marker secret in a fake project `.env` and proves it is not loaded.
- Health, ready, admin/runtime state, and product docs/catalog payloads report the Hub package version from one source.
- The version constant uses `createRequire(import.meta.url)` to read the shipped root `package.json`; it does not depend on `npm_package_version`, and is verified against both source execution and `node dist/index.js` layout.
- Production dotenv behavior remains supported and quiet.

**Verification:**

```powershell
npm test
npm run typecheck
npm run build
```

**Dependencies:** Task 4.

### Task 12A: Publish the security rollout and migration runbook

**Description:** Document the controls required to deploy Release S1 before quality-modernization work begins, so the security fixes are independently shippable.

**Likely files:**

- `HelmoraHub/.env.example`
- `HelmoraHub/README.md`
- `HelmoraHub/deploy/README.md`
- `HelmoraHub/docker-compose.yml`
- `HelmoraHub/sql/migrations/README.md`

**Acceptance criteria:**

- Local and public setup both require `HELMORA_SETUP_TOKEN`; docs generate at least 32 random bytes and warn against weak human-chosen values.
- Canonical origin configuration is mandatory for browser deployments and no request/proxy metadata is described as trusted origin input.
- `/health` vs `/ready`, missing/invalid setup-token behavior, exact process-local limiter windows/limits and `Retry-After`, pre-setup auth gating, ambiguous setup-delivery recovery, admin/recovery discriminated handoff, env/local shadow-and-restore behavior, opaque-cookie attributes, durable legacy auth scrubbing/one-time session invalidation, migration `005` preflight/remediation, and the no-auto-apply rule are explicit.
- Auth/control compression rejection and chat/vision inflated-size behavior are documented where request limits are described.
- Examples contain placeholders only and preserve the existing Cloudflared documentation changes owned by the user.

**Verification:**

- Cross-check every documented environment name and command against code.
- Scan the new diff for credential-like values and confirm placeholders only.

**Dependencies:** Tasks 2B, 3, 10, and 12.

### Release Gate S1: Security and contract sync

Release S1 consists of Tasks 1–12A. It is verified and reported as independently shippable before Task 13 starts. Strict-TypeScript modernization, CI authoring, or unrelated lint debt cannot block delivery of takeover/XSS/session/chat fixes.

- Run the full Hub and Frontend tests/builds applicable at this point.
- Run the CDP critical auth/legacy smoke subset from Task 16.
- Run `npm audit --omit=dev --audit-level=high` in both repositories.
- Run full `npm audit`, triage every high/critical finding for reachability and remediation, and record any justified deferment with a review date.

### Release Q1: Quality and delivery gates

### Task 13: Raise Frontend static-quality gates

**Description:** Enable strict TypeScript checking, resolve existing lint warnings, and keep the current UI behavior intact.

**Likely files:**

- `Helmora-Frontend/tsconfig.app.json`
- The specific source files reported by TypeScript/Oxlint
- `Helmora-Frontend/package.json`, if script normalization is needed

**Acceptance criteria:**

- `strict: true` is active for application code.
- Lint completes with zero warnings under the committed configuration.
- No suppression is added merely to hide an actionable type error.
- Frontend auth, chat, and settings routes still build.

**Verification:**

```powershell
npm test
npm run lint
npm run build
```

**Dependencies:** Tasks 6 and 7.

### Task 14: Add independent CI for both repositories

**Description:** Give each nested repository a reproducible quality gate using its own lockfile.

**Likely files:**

- `HelmoraHub/.github/workflows/ci.yml` (new)
- `Helmora-Frontend/.github/workflows/ci.yml` (new)

**Acceptance criteria:**

- CI uses the supported Node 22 line and `npm ci`.
- Hub CI runs tests, typecheck, and build.
- Frontend CI runs tests, lint, and build/typecheck.
- Workflows do not require production secrets for unit tests.

**Verification:**

- Validate workflow YAML locally by inspection and run every referenced command in its repository.

**Dependencies:** Tasks 12 and 13.

### Task 15: Synchronize remaining Frontend and CI documentation

**Description:** Document the secure initial setup and cross-origin deployment contract so operators do not accidentally reopen the vulnerability.

**Likely files:**

- `Helmora-Frontend/README.md`
- `HelmoraHub/README.md`, only for final CI/quality-command links not covered by Task 12A

**Acceptance criteria:**

- Frontend quick start explains its canonical Hub/Frontend origin contract and one-time credential behavior.
- Both repository READMEs list the exact local commands reproduced by CI.
- Documentation links to the Release S1 security rollout rather than duplicating or contradicting it.

**Verification:**

- All documented commands and environment names match the implemented code.
- Secret scan of the diff finds placeholders only.

**Dependencies:** Tasks 12A and 14.

### Task 16: Full automated and browser verification

**Description:** Run both repositories' complete quality gates, then exercise the critical workflow against isolated local data and configuration.

**Automated verification:**

```powershell
# HelmoraHub
npm test
npm run typecheck
npm run build
npm audit --omit=dev --audit-level=high

# Helmora-Frontend
npm test
npm run lint
npm run build
npm audit --omit=dev --audit-level=high
```

Run full `npm audit` separately as a triage report. A non-zero full-tree result blocks completion only when it contains an untriaged high/critical runtime-reachable issue; dev-only, unreachable, or currently unfixable advisories require a written rationale and review date rather than an automatic release failure.

**Browser tool and evidence:** Use the existing Chrome DevTools/CDP browser-testing capability; do not add Playwright solely for this smoke pass. The run is agent-driven and repeatable from the checklist, with screenshots plus console and network evidence recorded in the final report. The double-submit scenario must use a real DOM click and assert the network-request count, not only a unit helper.

**Browser scenarios:**

1. Loopback setup without a configured/submitted setup token fails closed.
2. A loopback listener behind a simulated proxy/tunnel still requires the token.
3. Missing, weak environment configuration, wrong, process-rate-limited, and correct setup-token cases; weak configuration follows the single repair-friendly unavailable path.
4. Weak configuration produces live health, not-ready readiness, unavailable auth status, and `503` setup consistently.
5. Successful setup displays generated credentials and does not navigate early.
6. Post-commit response loss switches to password login; authenticated admin/recovery rotation restores lost credentials.
7. Environment admin/recovery tokens alone cannot authenticate before password setup; setup returns the correct env-managed discriminator and no unusable generated token.
8. Environment credentials shadow local credentials; authenticated `/me` exposes diagnostics, public status does not, and restart without env restores the documented local state.
9. Migrated config contains no raw legacy secret/hash fields, old signed cookies fail, and an injected cleanup failure leaves auth unavailable rather than dual-sourced.
10. Production/local cookies have the specified name/attributes; logout revokes the session hash and clears cookies.
11. One submit action produces one setup/login request.
12. Login, use authenticated pages, logout, and login again without stale state.
13. Disallowed Origin fails while configured Frontend Origin succeeds.
14. Auth/control compressed bodies receive stable `415`; chat/vision inflated limits remain enforced.
15. Legacy settings page loads under CSP and renders hostile fixture text inertly.

**Acceptance criteria:**

- Every automated command exits successfully.
- No real `.env`, database, or production tunnel is used in verification.
- No console errors or unhandled promise rejections occur in the browser flow.
- No high/critical runtime-reachable dependency vulnerability remains untriaged.
- A final change summary distinguishes modified files, untouched owner changes, migration instructions, and residual risks.

**Dependencies:** Tasks 1–15, including 2A-1, 2A-2, 2A-3, 2B, and 12A.

## 7. Test strategy

### Unit tests

- Canonical origin parsing/normalization and allow/deny decisions, including proxy-header non-influence and parser edge cases.
- Mandatory bootstrap policy, token-strength bounds, fixed-digest timing-safe verification, and process-wide/per-source throttling.
- Environment/local precedence, restart restoration, and hash-only opaque-session persistence.
- Admin/recovery discriminated setup handoffs and pre-setup denial for env/local bearer/recovery credentials.
- Durable legacy-file cleanup, partial-migration fail-closed behavior, and SQLite-only restart.
- Cookie attributes, session-hash uniqueness/expiry/revocation, and bounded cleanup.
- Ambiguous post-commit delivery recovery through password login and credential rotation.
- Atomic admin-store migration and singleton compare-and-set behavior across independent store instances.
- Frontend response parsing and single-flight submission behavior.
- Session invalidation ordering and idempotence.

### Integration tests

- Hub auth routes, error contracts, cache headers, body limits, and CORS behavior.
- Oversized/malformed JSON, auth/control compression rejection, and chat/vision inflated-size behavior with route-specific parsers mounted before routers.
- Supabase client RPC invocation through mocked service responses.
- Canonical schema/migration invariants, duplicate preflight, missing-session behavior, validation bounds, and exact grants.

### Browser smoke tests

- Use Chrome DevTools/CDP for the critical setup/login/logout and legacy-page paths; capture screenshots, console output, and a network-request count.
- Use isolated local configuration and disposable storage.
- Inspect network requests to prove the double-submit regression is closed.

### Regression rule

Every confirmed bug receives a failing test before its fix wherever the layer is testable without coupling the test to implementation details.

## 8. Checkpoints and stop conditions

Implementation stops and reports back instead of guessing when:

- an existing owner change overlaps a file in a way that cannot be preserved safely;
- fixing a strict-TypeScript error requires a public behavior change not covered here;
- the Supabase production schema differs from the checked-in canonical schema;
- a new dependency or breaking API change becomes necessary;
- browser verification requires real production credentials or an external deployment mutation.

Otherwise, tasks proceed sequentially through all checkpoints in one implementation run.

## 9. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---:|---|
| Existing local or public installs do not configure `HELMORA_SETUP_TOKEN` before first boot | High | Fail closed, generate a random token in quick starts, and document rollout before deployment |
| CORS allowlist blocks a legitimate browser origin | Medium | Require canonical `PUBLIC_URL`/`FRONTEND_URL`, support explicit additional origins, and keep no-Origin server clients working |
| A diagnostic client depends on public auth-source fields | Medium | Keep setup/authenticated fields stable, move provenance to documented authenticated `/api/auth/me`, and update both bundled UIs/tests |
| Existing JSON admin state must move to atomic storage | High | Idempotent no-overwrite migration, isolated fixtures, and singleton/CAS tests before route changes |
| Setup commits but the response/handoff is lost | High | Do not retain replayable plaintext; refetch status, password login, then rotate admin/recovery credentials |
| Environment-managed admin token causes setup to display an unusable local token | High | Independent admin/recovery discriminated unions; never generate/store a local token for an environment-managed type |
| Removing environment management restores an old local credential | High | Make shadow/restore explicit, expose source metadata, and require operators to rotate local state before env removal when provenance is uncertain |
| Legacy cleanup fails after SQLite commit | High | Persist migration phase, fail readiness/auth closed, resume cleanup, and never merge/fallback between stores |
| Legacy signed sessions are invalidated during hash-only session migration | Medium | Document one-time re-login, migrate existing opaque session hashes where safe, scrub the raw signing secret, and permanently stop legacy reads |
| Process-local setup throttling is bypassed across multiple processes/restarts | Low | State its scope honestly; rely on strong token entropy and persistent SQLite CAS as security boundaries |
| Legacy CSP extraction changes page behavior | Medium | First add behavior/security tests, then extract assets without redesigning the page |
| Supabase migration encounters duplicate `(session_id, seq)` data | High | Add a preflight duplicate query and documented remediation; do not silently delete data |
| Strict TypeScript exposes broad existing debt | Medium | Fix by feature area, preserve behavior, and do not weaken the strict flags |
| Existing dirty Hub documentation is overwritten | High | Create only this dedicated plan and merge changes surgically; inspect diff before every task |

## 10. Definition of Done

The work is complete only when all conditions below are true:

- No unconfigured Hub, including a loopback listener reached through a proxy/tunnel, can be claimed without the operator's bootstrap secret.
- Admin setup is atomic in persistent local storage and exactly one concurrent caller can receive credentials.
- A committed-but-undelivered setup can be recovered using the chosen password followed by authenticated admin/recovery-token rotation; setup credentials are never replayed from storage.
- Setup returns independent admin/recovery generated-vs-environment-managed discriminators and never creates/displays a shadowed unusable local token.
- While setup is required, admin/recovery environment tokens cannot bypass password bootstrap or authenticate protected routes.
- Environment credentials exclusively shadow their corresponding local credentials for the process lifetime, source/shadow state is observable without secrets, and restart restoration follows the documented policy.
- Credential-source metadata is visible only to authenticated `/api/auth/me`, never public status.
- Cookie and SPA sessions use distinct opaque plaintext tokens and only unique hashes/kind/expiry are stored; the cookie token never appears in JSON, cookies use the specified host-only attributes, and logout/expiry revoke server-side state.
- Legacy migration removes raw/hash auth fields from runtime config, consumes the old session file, permanently disables legacy reads, and fails closed/resumable if cleanup is incomplete.
- Missing and invalid setup-token configuration produce consistent live/not-ready/status/`503` behavior without crashing or leaking validation details.
- The Hub accepts browser requests only from canonical configured trusted origins and never infers trust from request/proxy metadata.
- The Frontend preserves and displays generated one-time credentials, or explicitly represents environment-managed recovery, without caching/persisting the handoff.
- Setup/login cannot double-submit.
- Auth/control compressed request bodies are rejected with a stable `415`; chat/vision limits apply to inflated payload size.
- Logout clears credentials, requests, caches, and chat runtime state.
- The legacy privileged page does not execute server-provided markup and runs under an effective CSP.
- Supabase append and replace/import operations are atomic and sequence uniqueness is enforced.
- Tests do not load the developer's real environment file.
- Runtime version responses use one Hub version source.
- Both repositories pass their complete test, type, lint, and build gates; no high/critical runtime-reachable dependency vulnerability remains untriaged.
- Independent CI workflows reproduce those gates without production secrets.
- Deployment docs describe the new security contract and migration sequence.
- Existing owner changes remain intact and are clearly separated in the final diff summary.

## 11. Approval gate

Approval of this document authorizes implementation of Tasks 1–16 (including Tasks 2A-1, 2A-2, 2A-3, 2B, and 12A) in order, with Release S1 verified before Release Q1. Authorization includes additive setup fields plus intentional relocation of credential-provenance diagnostics from public status to authenticated `/api/auth/me`, independent admin/recovery setup discriminators, pre-setup auth gating, the mandatory setup-token policy and exact limiter defaults, the local atomic auth-store/session migration with durable legacy scrubbing and one-time signed-session invalidation, opaque host-only cookie changes, canonical CORS configuration, new environment variables, a new Supabase migration file, CI workflow files, and the described legacy-page asset extraction.

Approval does **not** authorize production deployment, applying the migration to a live Supabase project, committing, pushing, or publishing a release.
