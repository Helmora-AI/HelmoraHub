# Hybrid Control Plane Recovery Design

**Date:** 2026-07-15
**Status:** Approved, amended during implementation planning
**Surface:** HelmoraHub storage, Supabase schema, admin storage health

## Objective

Make Hybrid storage match Helmora's intended operational model:

- Supabase is the primary control plane for configuration and credentials.
- SQLite on the VPS stores workspace data and an encrypted, runtime-usable
  control-plane mirror.
- Supabase outages never prevent Hub boot when a local mirror is available.
- Offline control-plane changes are durably logged and replay automatically in
  the correct causal order when Supabase returns.

This work precedes the controlled `cloudflared` startup update.

## Data Ownership

### Supabase-primary control plane

- Providers, routing metadata, provider API credentials, and durable verification
  summaries such as last verified time, normalized result, and credential-invalid
  state.
- Helmora client API-key hashes, budgets, and lifecycle state.
- Agents, modes, Mini routing, Tools runtime, pricing, and other runtime settings.
- Connector credentials such as TinyFish.
- OAuth credential bundles and provider OAuth state.
- The first-class `/models` catalog, including default and benchmark pointers.

Every control-plane entity required at runtime has a local encrypted mirror.
Temporary cooldowns, latency samples, timeouts, and circuit-breaker state are
ephemeral runtime health. They are not control mutations and never enter the
outbox.

### SQLite-only workspace

- Playground chat sessions and messages.
- Usage and cost events.
- Tool-run activity and audit dimensions.
- Process-local/runtime cache metadata where persistence is already intended.

These high-volume workspace entities are not replicated to Supabase by the
Hybrid control-plane reconciler.

### SQLite control mirror and outbox

The control vault stores the latest complete, runtime-usable Supabase snapshot,
plus durable offline operations and synchronization state. Provider, connector,
OAuth, and any other credential material remains encrypted at rest. Neither
mirror JSON nor outbox payloads may contain plaintext secrets.

## Boot and Availability

Boot opens and validates SQLite before contacting Supabase.

1. Load the last complete local snapshot generation, operation overlay, and
   pending outbox.
2. If the snapshot manifest is usable, initialize runtime state and open the
   HTTP server immediately without waiting for a full remote timeout.
3. Start a bounded background capability probe. A short readiness probe may use
   at most two seconds, but remote latency never controls boot when a valid local
   snapshot exists.
4. Bootstrap and refresh the mirror when the remote control plane is ready.
5. If Supabase is unreachable, unauthorized, throttled, or missing required
   additive tables, mark the control plane `degraded`, retain a public-safe
   reason, and continue from the local snapshot plus operation overlay.
6. Local database corruption, an unusable encryption key, or an invalid local
   vault remains fatal; degraded mode must not conceal local integrity failure.

A first deployment without a usable complete snapshot opens recovery mode only.
Model-serving routes and normal admin mutation surfaces return:

```json
{
  "error": {
    "type": "control_snapshot_unavailable",
    "recoveryAvailable": true
  }
}
```

### Liveness, recovery readiness, and serving readiness

Process liveness, recovery readiness, and model-serving readiness are separate
signals. A live HTTP process must remain observable even when it cannot safely
serve models.

```ts
type ControlAvailability = {
  controlState: 'recovery_only' | 'degraded' | 'probing' | 'reconciling' | 'online';
  servingReady: boolean;
  recoveryReady: boolean;
};
```

- `GET /health` returns HTTP 200 whenever the Hub process, HTTP stack, and local
  SQLite workspace are live. Its response includes `controlState`,
  `servingReady`, and `recoveryReady`.
- `GET /ready` returns HTTP 200 only when `servingReady=true`; otherwise it
  returns HTTP 503, including when the process is healthy and recovery-ready.
- A valid complete local snapshot can make `servingReady=true` while Supabase is
  degraded or unavailable.
- A missing or unusable snapshot makes `servingReady=false`. Recovery endpoints
  may still make `recoveryReady=true` when independent recovery authentication
  and the storage repair surface are available.
- Load balancers and deployment readiness checks use `/ready`. Process monitors
  and diagnostics use `/health`.

### Recovery authentication

Recovery authentication is independent from Supabase and normal Helmora API
keys. Its credential source is:

```text
HELMORA_RECOVERY_TOKEN environment value
-> otherwise a locally stored recoveryTokenHash created during successful admin setup
-> otherwise recovery login is unavailable and startup health explains how to configure it
```

When `HELMORA_RECOVERY_TOKEN` is present it is authoritative and the local hash
is ignored, allowing an operator-controlled emergency rotation. Plain recovery
tokens are never persisted. Comparison is constant-time and login is covered by
the strict auth rate limiter.

`POST /api/auth/recovery-login` accepts `{ "token": string }` and issues a
short-lived session with an explicit `aud: "helmora-recovery"` capability. It
does not issue or reuse a full Admin SPA session. Recovery sessions expire after
15 minutes, cannot be refreshed into admin sessions, and remain recovery-only
even if the control snapshot becomes available during their lifetime.

```ts
type RecoveryLoginResponse = {
  ok: true;
  token: string;
  scope: 'recovery';
  expiresAt: string;
};
```

The opaque recovery session token is accepted only as an Authorization bearer
on the recovery allowlist and is never accepted by `requireAdmin` or model API
authentication. `GET /api/auth/status` adds masked `recoveryAvailable` and
`recoveryMode` booleans without revealing the credential source.

Normal Helmora API keys and ordinary admin sessions are unavailable as recovery
credentials when no control snapshot exists.

A recovery session is capability-limited to this allowlist:

```text
GET  /api/auth/status
POST /api/auth/recovery-login
GET  /api/storage/health
POST /api/storage/test
GET  /api/settings/storage
GET  /api/settings/storage/schema
PUT  /api/settings/storage
```

`POST /api/storage/test` performs a bounded, cache-free capability probe. It may
use request-supplied Supabase bootstrap values without persisting or logging
them, and returns normalized capability results with all secrets masked.

```ts
type RecoveryStorageTestInput = {
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
  encryptionKey?: string;
};

type RecoveryStorageTestResponse = {
  ready: boolean;
  capabilities: Array<{
    id: string;
    status: 'ready' | 'missing' | 'denied' | 'unreachable' | 'invalid';
    errorCode?: string;
  }>;
  missingCapabilities: string[];
};

type RecoveryStorageHealthResponse = {
  controlState: 'recovery_only' | 'degraded' | 'probing' | 'reconciling' | 'online';
  snapshotAvailable: boolean;
  activeGeneration: string | null;
  recoveryAvailable: boolean;
  degradedReason: string | null;
};

type RecoveryStorageUpdateInput = {
  supabaseUrl?: string;
  supabaseCredentialOperation?:
    | { kind: 'retain' }
    | { kind: 'replace'; value: string };
  storageModeOperation?:
    | { kind: 'retain' }
    | { kind: 'switch_to_sql' };
};
```

The recovery-mode `PUT /api/settings/storage` accepts only storage connection
and bootstrap repair fields; it cannot mutate unrelated runtime settings.
Responses remain masked. The session cannot call model-serving routes, manage
API keys, modify providers/models, read control credentials, or access ordinary
admin mutation surfaces. Leaving recovery mode requires a valid control snapshot
and normal authentication; a recovery session is never silently upgraded into
a full admin session.

Recovery storage updates require at least one changed field and obey these exact
secret and transition rules:

- The Supabase URL is non-secret connection metadata and may be persisted
  locally.
- When `SUPABASE_SERVICE_ROLE_KEY` is environment-managed, API replacement is
  forbidden and returns HTTP 409 `credential_env_managed`.
- When the Supabase secret is locally managed, `replace` encrypts it in the
  dedicated local recovery vault. It never enters generic runtime settings JSON.
- Secret clear is intentionally absent from the DTO and is always forbidden.
- The local encryption key is not accepted, replaced, cleared, or rotated through
  the H1 recovery update API. Key rotation belongs to H4.
- Storage mode transitions are allowlisted. H1 permits only retaining the current
  mode or switching to `sql`; arbitrary mode strings and implicit downgrades are
  rejected.

`RecoveryStorageTestInput` remains transient and may accept request-supplied
bootstrap material for a cache-free probe, but it never persists those values. A
successful update returns masked configuration and `restartRequired`, matching
the existing storage-settings lifecycle.

New admin setup generates and returns a recovery token once and stores only its
local hash. `POST /api/auth/rotate-recovery-token` requires normal full-admin
authentication, invalidates the previous local hash, and returns
`{ "recoveryToken": string }` exactly once. When the environment token is
authoritative, rotation returns HTTP 409 `recovery_token_env_managed` without
creating a local token. Existing deployments must set `HELMORA_RECOVERY_TOKEN`
before the H1 restart or rotate a recovery token while normal admin
authentication is still available.

## Schema Readiness and Migrations

The Settings connection test probes every table/capability used by the active
Hybrid runtime, not only `helmora_settings`. It returns all missing capabilities
in one field-addressable response.

Existing installations receive a standalone additive migration for Tools
control tables, the control mutation ledger/RPC, revisions, and model catalog
control tables. The full `sql/supabase-schema.sql` remains the idempotent source
of truth. Applying DDL is an explicit administrator operation; Hub never runs
arbitrary schema DDL through runtime credentials.

Schema mismatch is a degraded health reason and admin warning, not an
unhandled boot exception.

## Local Write-Ahead Control Mutations

Supabase remains the authoritative control plane, but every control mutation is
locally durable before any remote attempt. Remote-first writes are forbidden.

```ts
type ControlMutationEnvelope = {
  operationId: string;
  idempotencyKeyHash: string;
  requestFingerprint: string;
  entityType: string;
  entityId: string;
  action: string;
  causalGroup: string;
  baseRevision: number | null;
  patch: SecretSafePatch | EncryptedPayload;
  createdAt: string;
};
```

Every H2 control-mutation endpoint requires an `Idempotency-Key` header of
16--128 visible ASCII characters excluding whitespace and control characters.
The Admin SPA generates one UUID once per logical save and retains it across
network retries and ambiguous responses. It creates a new UUID only after a
terminal response or after the user changes the logical draft. Hub scopes the
key to the authenticated actor plus route/action, stores only its hash, and maps
it to one stable server-generated `operationId`.

The request fingerprint is HMAC-SHA-256 over the canonical validated mutation,
using a local server key. Secret input participates in the in-memory HMAC but is
never copied into the fingerprint or logs. Its canonical input is the HTTP
method, normalized route/action, authenticated actor identity, target entity
identity, and normalized validated body. It is never calculated from raw JSON.
Transport-only fields, property order, omitted defaults, and randomized
ciphertext bytes are excluded so a semantic retry produces the same fingerprint.

- Same scoped key and same canonical request fingerprint returns the existing
  operation receipt and never creates another mutation.
- Same scoped key with a different fingerprint returns HTTP 409
  `idempotency_key_reused`.
- Missing or malformed keys return HTTP 400 before a local operation is created.
- Internal reconciler retries always reuse the stored `operationId`; they do not
  create a new client idempotency scope.

Applied idempotency receipts are retained for 30 days. Pending and conflict
receipts are retained until resolved, then retained for the same 30-day window.
Cleanup is bounded to at most 500 terminal receipts per pass and never removes an
active pending/conflict operation or an unexpired secret-delivery envelope.

```ts
type ControlMutationReceipt = {
  operationId: string;
  syncStatus: 'applied' | 'pending';
  entityType: string;
  entityId: string;
  revision: number | null;
};
```

An online remote commit returns the endpoint's normal success status with an
additive `controlMutation` receipt. A locally durable operation awaiting remote
replay returns HTTP 202 with the same receipt shape. A retry returns the current
receipt and canonical public result for that operation.

Exactly-once mutation does not imply replaying one-time plaintext. For client
API-key creation, remote state and hashes are deduplicated by operation ID, but a
lost plaintext response is not reconstructed from the remote ledger. The local
vault retains an encrypted delivery envelope for at most 10 minutes with these
semantics:

- It is bound to the authenticated actor ID, stable operation ID, idempotency-key
  hash, and created API-key hash.
- The same actor and idempotency key may retrieve the same plaintext repeatedly
  until expiry, including after a process restart.
- It is not listable and cannot be fetched by API-key ID alone.
- Setting `deliveredAt` records delivery but does not delete or invalidate the
  envelope before expiry.
- Every successful and rejected delivery attempt creates a redacted audit event.
- The envelope is local-only, encrypted, and never synchronized to Supabase.
- Bounded cleanup removes it only after expiry. A retry after 10 minutes returns
  `secret_delivery_expired` and never creates another API key.

The mutation path is:

1. Validate the request and authorization locally.
2. Begin one SQLite transaction.
3. Generate a globally unique `operationId` and persist the mutation envelope.
4. Add the intended change to the local operation overlay and commit SQLite.
5. When state is `online`, send the envelope through an idempotent Supabase RPC.
6. On remote success, persist the canonical remote revision/result locally and
   mark the operation `applied`.
7. On a degradable failure or an ambiguous timeout, retain the overlay and
   `pending` operation, enter `degraded`, and return success with synchronization
   metadata containing `operationId` and `syncStatus` because the mutation is
   locally durable.
8. On a deterministic remote rejection, remove the effective overlay and expose
   the prior canonical state; mark the operation `failed` or `conflict`, suspend
   dependent overlays in the same causal group, and return the normalized error.

The effective local control view is the active complete snapshot generation
plus its ordered durable operation overlay. This avoids destructive rollback of
base snapshot rows and ensures a later snapshot activation cannot erase a newer
accepted local mutation.

Workspace reads and writes always use SQLite regardless of control-plane state.

### Remote idempotency and logical transactions

Supabase owns a mutation ledger keyed uniquely by `operationId`. The transactional
RPC checks the ledger, applies the logical mutation and revision update, stores a
public-safe canonical result, and marks the ledger entry applied in one database
transaction. Repeating an operation after a timeout returns the recorded result
without applying it twice.

Multi-record invariants are one logical mutation, including:

- Provider plus encrypted credential.
- Model plus default or benchmark pointer.
- API key plus budget and lifecycle state.
- OAuth bundle plus `authMode` and connected state.

They are never replayed as independent REST writes. One-time plaintext values
such as a newly generated client API key are returned only by the original local
request path and are not stored in the remote mutation ledger.

H2 implements this contract for non-secret control mutations. API-key and OAuth
entries above define their eventual logical transaction boundary, but their
mutations remain online-only/fail closed through H3. H4 enables their idempotent
mutation paths and API-key secret delivery.

## Failure Transition and Offline Writes

Remote failures are classified. Transport, timeout, retryable upstream,
credentials/access, and schema-readiness failures may enter degraded mode;
local validation and encryption failures do not.

Because the operation is written locally first, a timeout after an unknown
remote commit cannot duplicate it: the reconciler retries the same
`operationId`. During `degraded`, `probing`, and `reconciling`, request-time
control writes commit only to the local overlay and outbox. They never bypass
the reconciler to write Supabase directly.

## Durable Operation Log

Outbox rows have an ordered local sequence and explicit status:

```ts
type ControlSyncStatus =
  | 'pending'
  | 'replaying'
  | 'applied'
  | 'failed'
  | 'conflict';
```

Each operation stores entity, entity ID, action, a secret-safe patch or encrypted
payload, causal group, base revision, created time, attempt count, last attempt
time, normalized error code, applied time, lease owner, and lease expiry. Raw
upstream errors and plaintext credentials are never stored or returned.

On startup, any `replaying` row without a live lease returns to `pending` and
records `replay_interrupted`. A fencing generation prevents a previous process
or expired reconciler from marking an operation applied.

Operations remain idempotent by operation ID. Applied history is retained for a
bounded diagnostic window. Compaction is permitted only for pure idempotent
field patches whose final meaning and audit lineage remain intact. It is
forbidden for create/delete, credential rotate/clear, API-key create/revoke,
OAuth connect/disconnect, CAS-protected catalog pointers, and any operation with
an external one-time effect.

Ordering is strict within one entity or declared causal group. A conflict blocks
dependent operations in that group but does not head-of-line block unrelated
entities. For example, a conflict on provider A blocks its credential and model
dependencies while provider B and an independent pricing setting may continue.

## Automatic Recovery

A single background reconciler owns remote probes and replay. It starts after
storage initialization, uses bounded exponential backoff with jitter, prevents
overlapping runs, and stops cleanly during Hub shutdown.

A shared mutation gate and fencing token serialize reconciler replay, snapshot
activation, and direct online control mutations. State determines ownership:

```text
online       remote mutation is permitted through the write-ahead coordinator
degraded     request writes are local overlay + outbox only
probing      request writes are local overlay + outbox only
reconciling  request writes are local overlay + outbox only;
             reconciler exclusively owns the remote mutation stream
```

Recovery order is:

```text
degraded
-> probing
-> remote capability probe
-> reconciling
-> replay pending operations by causal ordering
-> refresh complete control snapshot
-> atomically activate and verify the snapshot generation
-> online
```

Only after replay completes and a full snapshot generation activates may the
state return to `online`. Failure leaves the current and remaining operations
retryable and returns the state to degraded. A restart resumes from the durable
outbox and persisted plane metadata.

## Conflict Policy

The current Pterodactyl deployment is single-writer: control-plane mutations
must go through this Hub. Within a local entity or causal group, monotonic local
sequence determines the effective overlay. It does not silently override an
unexpected remote revision.

Control records gain a revision. Each offline patch records its base revision.
If the remote revision changed unexpectedly, replay does not overwrite it
silently. Non-overlapping patches may merge; same-field changes become
`conflict` and remain visible for administrator resolution. Direct Supabase
editing while Hub is offline is therefore detectable rather than silently lost.

## Atomic Snapshot Generations

A refresh never writes table-by-table into the active mirror. It stages a new
generation and switches it atomically only after completeness validation.

```ts
type ControlSnapshotManifest = {
  generationId: string;
  generation: number;
  formatVersion: 1;
  buildSchemaVersion: number;
  encryptionVersion: number;
  createdAt: string;
  completedAt: string | null;
  complete: boolean;
  capabilities: Array<{
    id: string;
    tier: 'core_serving' | 'enabled_feature' | 'optional_admin';
    present: boolean;
  }>;
  entityCounts: Record<string, number>;
  checksum: string;
};
```

### Legacy generation-zero promotion

H1A may promote existing legacy mirror rows exactly once into generation zero.
Promotion is allowed only when all of these checks pass for the current build:

1. Every `core_serving` capability is present.
2. Every `enabled_feature` capability is present for features enabled by the
   legacy settings. A disabled feature does not make its capability required.
3. Missing `optional_admin` capabilities are reported but do not block serving.
4. Every encrypted record required by the promoted capabilities decrypts with the
   active local key and every cross-entity reference resolves.
5. No local schema/vault migration is running or left incomplete.
6. A trusted local source/synchronization marker proves the rows came from a
   previously successful control-plane read or locally authoritative legacy
   setup. Mere presence of rows is insufficient.
7. The manifest records generation `0`, `formatVersion`, the current
   `buildSchemaVersion`, creation/completion timestamps, `complete=true`, the
   tiered capability results, entity counts, and a checksum over the canonical
   promoted snapshot.
8. The generation-zero manifest and `activeGeneration` pointer commit in the same
   SQLite transaction.

Failure of any blocking check leaves the legacy rows untouched and enters
recovery-only mode. Promotion is never inferred from table existence alone and
is never retried as a different generation without an explicit repair/import.

Every mirrored row belongs to a `snapshotGeneration`. Refresh performs:

1. Create staging generation G.
2. Fetch every required control capability into G.
3. Validate manifest capabilities, references, revisions, counts, encrypted
   credential envelopes, and required records.
4. Mark G complete.
5. Atomically switch `activeGeneration` to G.
6. Reapply the durable operation overlay when projecting effective local state.
7. Garbage-collect older generations only after a retention window.

If any capability fails, G remains incomplete and is never runtime-usable. The
previous active generation remains untouched. Absence from a newly completed
generation represents deletion; incomplete refreshes never delete or replace
last-known-good entities.

A database containing isolated legacy mirror rows without a complete manifest
is not a valid local snapshot.

## Complete Mirror Requirements

Refreshing the mirror includes all runtime-critical settings and entities, not
only `active_mode`. At minimum it covers:

- Provider and agent records.
- Helmora API-key records.
- Connector and OAuth credentials as ciphertext.
- Mini, Tools, pricing, mode, and routing settings.
- The `/models` catalog and its pointers.

Capability tiers make completeness build- and configuration-aware:

- `core_serving` is mandatory for every runtime-ready snapshot.
- `enabled_feature` is mandatory only when its corresponding feature is enabled
  in the candidate snapshot.
- `optional_admin` may be absent without blocking model serving, but health and
  Admin surfaces expose the omission.

H3 mirrors Helmora API-key hashes, budgets, lifecycle state, and any data needed
for offline authentication reads. API-key creation, rotation, revocation, and
budget mutation remain online-only and fail closed through H3. H4 is the first
increment that enables those API-key mutations through the logical idempotent
mutation and delivery-envelope contracts.

Deletion is represented only by absence from a complete activated generation or
an explicit pending delete operation in the local overlay.

## Credential Safety

- Decrypted remote credential material exists only transiently in memory inside
  the credential boundary. Supabase and SQLite store only ciphertext/envelope.
  Supabase and the local vault use distinct key identities; remote ciphertext is
  immediately re-encrypted in memory with the local vault key and plaintext is
  never written to an intermediate row, file, outbox payload, or log.
- Every credential envelope carries `encryptionVersion`, `keyId`, nonce, and AAD
  derived from `entityType + entityId + credentialType + schemaVersion` so a
  provider, connector, or OAuth ciphertext cannot be substituted across
  entities.
- Key rotation writes a new envelope before retiring the previous key and is
  resumable by envelope version. A missing required key makes that credential
  unusable and visible in health; it never falls back to plaintext.
- H4 offline Helmora client API-key creation stores one-time plaintext only in
  the encrypted local delivery envelope; synchronization uses a pre-hashed record
  or encrypted transient payload, never plaintext outbox JSON.
- Secret-bearing mirror migrations replace any legacy plaintext vault payloads
  atomically after validation.
- Logs, health payloads, state transitions, and sync errors contain IDs and
  normalized codes only.

## Model Catalog

The `/models` catalog becomes Supabase-primary. Every catalog mutation uses the
same local write-ahead envelope and idempotent remote RPC. The local overlay
keeps accepted degraded mutations available. Replay preserves stable catalog
IDs, provider dependencies, and pointer CAS revisions before marking applied.

Existing SQLite catalog data is imported once when Supabase has no catalog.
When both sides already contain data, the migration reports a conflict and
requires an explicit source choice; it never silently overwrites either side.

## OAuth in Hybrid Mode

Hybrid storage must no longer reject OAuth because the top-level store is not a
`SqliteConfigStore`. OAuth bundles use the same Supabase-primary/encrypted-local
mirror contract. Pending PKCE state is short-lived workspace coordination: it
remains encrypted in local SQLite, expires locally, and is not synchronized to
Supabase in this slice.

Provider OAuth flags and encrypted bundles must reconcile as one logical
operation and one remote database transaction so a provider cannot appear
connected without a usable credential.

## Observability

Storage health exposes:

- Control state and normalized degraded reason.
- Local snapshot availability and age.
- Last remote success/failure and next probe time.
- Pending, replaying, failed, and conflict counts.
- Last successful reconcile generation.

Admin APIs never expose operation payloads or secrets. Server logs record state
transitions once rather than repeating the same outage on every request.

## Testing

Required tests include:

- Missing connector/tool table at boot enters degraded mode and Hub remains up.
- Supabase network/auth failure at boot uses a valid local snapshot.
- A valid local snapshot opens HTTP readiness without waiting for the full
  Supabase timeout.
- `/health` stays HTTP 200 for a live recovery-only process while reporting
  `servingReady=false`; `/ready` returns HTTP 503 until serving is actually safe.
- Generation-zero promotion rejects missing current-build core capabilities,
  enabled-feature gaps, invalid references/decryption, untrusted legacy rows, and
  incomplete migrations; manifest plus active pointer are atomic.
- No-snapshot recovery accepts only the bootstrap/recovery credential and route
  allowlist; normal API keys and model routes remain unavailable.
- Environment recovery token precedence, local-hash fallback, rate limiting,
  15-minute expiry, and recovery-session audience isolation are deterministic.
- Storage recovery tests are cache-free, capability-complete, and never persist
  request-supplied bootstrap secrets.
- Invalid/corrupt local SQLite or encryption state remains fatal.
- Settings connection test reports every missing required table.
- Every online mutation persists its local write-ahead envelope before remote
  dispatch.
- A client retry with the same idempotency key and request fingerprint returns
  one operation; reusing the key with a different fingerprint returns 409.
- Missing or malformed mutation idempotency keys fail before local persistence.
- Request fingerprints are stable across semantic retries and disclose no secret
  input or randomized ciphertext.
- Admin SPA retries reuse one idempotency UUID for the same logical save and
  create a new UUID only after a terminal response or changed draft.
- Canonical request fingerprints ignore raw JSON ordering/default noise and bind
  method, route/action, actor, normalized body, and entity identity.
- API-key plaintext delivery envelopes are local-only, encrypted, restart-safe,
  bound to actor/operation/idempotency/key hash, repeatedly retrievable until the
  10-minute expiry, never listable by key ID, and never create a duplicate key.
- A timeout after a committed remote mutation retries the same operation ID and
  applies exactly once.
- The write that triggers degradation stays effective locally and is queued
  exactly once.
- Restart resumes persisted plane/outbox state and automatic reconciliation.
- Orphaned `replaying` leases return safely to `pending` after restart.
- Replay is causal, idempotent, bounded, fenced, and non-overlapping with
  request-time remote writes.
- A conflict blocks its causal group while independent entities continue.
- Retry failure leaves unapplied operations pending with safe diagnostics.
- An interrupted or partial snapshot generation never replaces the active
  generation.
- Snapshot activation preserves newer operation overlays and represents remote
  deletions only after completeness validation.
- Complete settings and model catalog generations survive offline restart.
- Provider, connector, OAuth, and API-key outboxes contain no plaintext secret.
- Credential re-encryption uses key IDs, versions, entity-bound AAD, and never
  persists plaintext intermediate material.
- Multi-entity provider, catalog pointer, API-key, and OAuth mutations are
  remotely atomic.
- Ephemeral cooldowns, timeouts, and circuit state never create outbox rows.
- Revision conflict prevents silent same-field overwrite.
- Chat, usage, and tool activity remain SQLite-only.

## Rollout

### H1A -- Boot survival patch

- Boot SQLite and activate a complete local snapshot before remote probing.
- Validate a legacy mirror once and atomically promote it to generation zero;
  H1 adds the minimum completeness manifest needed for this promotion, while H3
  adds full staged refresh generations. Incomplete legacy rows remain
  recovery-only rather than being assumed valid.
- Convert Supabase/schema startup failures into degraded health.
- Probe the complete active schema capability set.
- Separate process liveness, recovery readiness, and serving readiness in the
  HTTP contracts.
- Preserve current mutation semantics temporarily; H1A/H1B do not claim safe
  offline writes.

H1A may release independently only when the production snapshot has been
independently verified complete under the generation-zero algorithm and
no-snapshot recovery is not required for that restart. Otherwise H1B is part of
the same release gate.

### H1B -- Recovery surface

- Add independent, narrowly scoped recovery authentication, token rotation,
  `.env.example`, and VPS recovery setup documentation.
- Expose masked storage health, cache-free capability testing, and the dedicated
  recovery storage update DTO.
- Keep no-snapshot deployments serving-disabled while making the repair surface
  reachable through independent recovery authentication.

### H2 -- Transactional outbox

- Add required client idempotency keys, local write-ahead envelopes, operation
  receipts, and operation overlays.
- Add the Supabase mutation ledger and transactional idempotent RPC.
- Serialize request mutations and reconciler ownership by state/fencing.
- Recover leases after restart and replay by causal ordering.

### H3 -- Atomic complete mirror

- Add snapshot generations, completeness manifests, atomic activation, and GC.
- Mirror all settings and migrate `/models` to Supabase primary.
- Add revision conflicts, dependency blocking, and explicit catalog source
  choice.

### H4 -- Secret entities and OAuth

- Re-encrypt provider and connector credentials into the local vault with
  entity-bound envelopes and rotation support.
- Make provider credential, connector credential, and OAuth state logical
  transactional entities.
- Enable Hybrid OAuth without weakening local PKCE expiry behavior.

Apply the idempotent Supabase schema/additive migrations required by each
increment before enabling that increment. Verify outage, restart, replay,
snapshot, and conflict scenarios before resuming Tools runtime implementation.

Each increment is rollback-friendly and leaves existing local-only SQLite mode
unchanged.

## Success Criteria

- Supabase outage or additive schema lag cannot crash a Hub with a valid local
  snapshot.
- A valid snapshot makes Hub ready without waiting on remote control-plane
  latency; a missing snapshot exposes only independently authenticated recovery.
- Runtime control data remains usable offline without exposing plaintext
  credentials.
- Every control mutation is locally write-ahead and remotely exactly-once by
  operation ID, including ambiguous timeout recovery.
- Every accepted offline mutation has a durable visible sync state.
- Reconnection automatically replays and refreshes without manual process
  restart.
- Runtime never observes a partially refreshed control generation.
- Reconciliation cannot race request-time remote mutations or globally block on
  an unrelated entity conflict.
- `/models` is Supabase-primary and remains available from its local mirror.
- Hybrid OAuth uses encrypted primary and mirror credentials.
- Workspace chat, usage, and tool activity never move to Supabase.
- Local-only storage behavior remains compatible.

## Open Questions

None.
