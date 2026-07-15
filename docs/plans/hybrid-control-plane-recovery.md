# Implementation Plan: Hybrid Control Plane Recovery

**Date:** 2026-07-15
**Status:** Approved; H1A/H1B implemented and release-verified, H2-H4 pending
**Design:**
[`../superpowers/specs/2026-07-15-hybrid-control-plane-recovery-design.md`](../superpowers/specs/2026-07-15-hybrid-control-plane-recovery-design.md)

## Overview

Harden HelmoraHub Hybrid storage in rollback-friendly increments. H1A is the
minimum production boot-survival patch. H1B adds the independently authenticated
recovery surface. H2 adds transactional local write-ahead operations and
exactly-once remote application. H3 adds atomic complete snapshot generations
and makes `/models` Supabase-primary. H4 moves all secret-bearing entities and
OAuth onto the same encrypted transactional contract.

Tools runtime work and the controlled `cloudflared` update remain paused until
the applicable H1A/H1B deployment checkpoint passes.

**Implementation checkpoint (2026-07-15):** H1.1-H1.8 and the **Safe to Restart
VPS With Recovery** gate passed with 442 Hub tests, typecheck, production build,
schema/diff checks, and secret review. H2-H4 remain follow-on work and are not
claimed by the H1 deployment documentation.

## Current Failure

The current Hybrid startup path is:

```text
open SQLite workspace
-> bootstrap Supabase
-> construct HybridConfigStore
-> refresh connector credentials from Supabase
-> open HTTP server
```

If an additive Supabase table such as `helmora_connector_credentials` is missing,
`refreshVaultFromControl()` throws before Express starts. The Hub cannot expose
health, schema SQL, or repair settings, even when local SQLite contains usable
control data.

## Architecture Decisions

- H1A/H1B change availability and recovery behavior only; they do not claim safe
  offline control mutations.
- A locally complete mirror starts the HTTP server before any long Supabase
  timeout. Remote probing continues in the background.
- Missing schema, network, auth, and throttling are normalized degraded reasons;
  local SQLite corruption and unusable encryption remain fatal.
- Recovery authentication uses `HELMORA_RECOVERY_TOKEN` or a local recovery hash
  and can access only the approved recovery routes.
- H2 requires `Idempotency-Key` for control mutations. The Admin SPA owns one
  UUID per logical save, while Hub deduplicates both client-to-Hub and
  Hub-to-Supabase retries by canonical fingerprint.
- H3 stages complete snapshot generations and atomically activates one manifest.
- H4 re-encrypts remote secrets into a distinct local vault envelope in memory.
- Chat, usage, and tool activity remain SQLite-only throughout the rollout.

## Dependency Graph

```text
H1A schema failure classification
    -> H1A generation-zero completeness manifest
        -> H1A local-first Hybrid startup
            -> H1A liveness/readiness and model-route gate
                -> H1A production snapshot gate
                    -> H1B recovery credentials and sessions
                        -> H1B recovery storage APIs
                            -> H1B safe-restart checkpoint

H1A/H1B
 -> H2 local mutation ledger + idempotency contract
    -> H2 Supabase operation RPC
       -> H2 Admin SPA logical-save idempotency
          -> H2 mutation coordinator
             -> H2 reconciler leases/fencing

H2
 -> H3 snapshot generation staging
    -> H3 complete mirror projection
       -> H3 Supabase-primary model catalog + conflicts

H3
 -> H4 credential envelope migration
    -> H4 provider/connector/API-key logical entities
       -> H4 Hybrid OAuth
          -> final outage and rollout review
```

## H1A -- Boot Survival Patch

### Task H1.1: Normalize startup capability failures

**Description:** Add a typed schema/capability probe result and startup failure
classifier so missing tables, network failures, authorization failures,
throttling, and timeouts can become public-safe degraded reasons instead of
unhandled exceptions.

**Acceptance criteria:**

- [ ] A missing `helmora_connector_credentials` table classifies as
  `schema_incomplete` and lists the missing capability.
- [ ] Network/auth/throttle failures have stable normalized codes and redact the
  upstream payload.
- [ ] SQLite/encryption integrity failures are never classified as degradable.

**Verification:**

- [ ] RED then GREEN: focused cases in `supabase-schema.test.ts` and
  `control-plane.test.ts`.
- [ ] `npm.cmd run typecheck`.

**Dependencies:** None

**Files likely touched:**

- `src/lib/supabase-schema.ts`
- `src/storage/control-plane.ts`
- `src/__tests__/supabase-schema.test.ts`
- `src/__tests__/control-plane.test.ts`

**Estimated scope:** M

### Task H1.2: Add the minimum local snapshot manifest

**Description:** Extend the SQLite control vault with a completeness manifest and
legacy generation-zero promotion. H1A needs only enough generation semantics to
prove that the local mirror is safe to boot; full staged refresh arrives in H3.

**Acceptance criteria:**

- [ ] Generation-zero manifest records `generation=0`, `formatVersion`, current
  `buildSchemaVersion`, created/completed timestamps, `complete`, tiered
  capabilities, entity counts, encryption version, and canonical checksum.
- [ ] Promotion requires every current-build `core_serving` capability and every
  `enabled_feature` capability whose feature is enabled; missing
  `optional_admin` capability is warned but does not block serving.
- [ ] All required data decrypts, all cross-entity references resolve, no
  migration is in progress, and a trusted local source/sync marker exists.
- [ ] A valid legacy mirror is promoted atomically: manifest and active pointer
  commit in the same SQLite transaction.
- [ ] Partial legacy rows never count as a usable snapshot.
- [ ] Manifest state and active generation survive process restart.

**Verification:**

- [ ] RED then GREEN: focused `control-vault.test.ts` manifest and legacy cases.
- [ ] Existing connector-vault and local storage tests remain green.

**Dependencies:** H1.1

**Files likely touched:**

- `src/storage/control-vault.ts`
- `src/storage/control-plane.ts`
- `src/__tests__/control-vault.test.ts`

**Estimated scope:** M

### Task H1.3: Start Hybrid from local state before Supabase

**Description:** Reorder storage initialization so SQLite and a valid snapshot
become usable first. Supabase bootstrap/refresh runs through a bounded probe; a
degradable failure returns a live `HybridConfigStore` in degraded state.

**Acceptance criteria:**

- [ ] Missing connector/tool tables no longer reject `initStorage()` when a
  complete local snapshot exists.
- [ ] The last valid local providers, API-key hashes, agents, and settings remain
  readable in degraded mode.
- [ ] Corrupt SQLite or an unusable local encryption key still fails startup.

**Verification:**

- [ ] RED then GREEN: new focused Hybrid boot test reproduces the production
  missing-table exception before the fix.
- [ ] Existing `hybrid-store-online`, `hybrid-store-degraded`, and connector-vault
  tests pass.

**Dependencies:** H1.1--H1.2

**Files likely touched:**

- `src/storage/index.ts`
- `src/storage/hybrid-store.ts`
- `src/storage/control-plane.ts`
- `src/__tests__/hybrid-store-boot.test.ts`

**Estimated scope:** M

### Task H1.4: Separate liveness/readiness and gate unavailable snapshots

**Description:** Open Express after local storage initialization without waiting
for a long remote probe. Start the probe lifecycle after listen, expose distinct
liveness/recovery/serving readiness, and gate model and ordinary admin routes
when no complete snapshot exists.

**Acceptance criteria:**

- [ ] `GET /health` returns HTTP 200 while the HTTP process and SQLite workspace
  are live and reports `controlState`, `servingReady`, and `recoveryReady`.
- [ ] `GET /ready` returns HTTP 200 only for `servingReady=true`; it returns HTTP
  503 for a healthy recovery-only process.
- [ ] A valid local snapshot reaches serving readiness without waiting for the
  full Supabase timeout.
- [ ] No-snapshot model routes return `control_snapshot_unavailable` with
  accurate `recoveryAvailable`; `/health` and `/ready` remain reachable. H1B is
  responsible for making the independently authenticated repair routes ready.
- [ ] Probe lifecycle starts once, cannot overlap, and stops during shutdown.

**Verification:**

- [ ] RED then GREEN: focused startup/readiness and route-gate tests.
- [ ] Existing `/v1`, Admin Chat, health, and SPA route tests remain green.

**Dependencies:** H1.3

**Files likely touched:**

- `src/index.ts`
- `src/app.ts`
- `src/storage/index.ts`
- `src/middleware/requireControlSnapshot.ts`
- `src/__tests__/hybrid-startup.test.ts`

**Estimated scope:** M

## Checkpoint H1A -- Boot Survival Release Gate

- [ ] The production snapshot is independently inspected and satisfies the exact
  generation-zero completeness algorithm.
- [ ] Missing Supabase tables and remote outages do not crash a Hub with that
  valid local snapshot.
- [ ] `/health` and `/ready` demonstrate the distinct liveness and serving
  contracts.
- [ ] The original production missing-table regression passes.
- [ ] H1A may release alone only when no-snapshot recovery is not required for
  this restart; otherwise continue through H1B before deployment.

## H1B -- Recovery Surface

### Task H1.5: Add recovery credential primitives

**Description:** Add `HELMORA_RECOVERY_TOKEN`, local recovery-token hashing,
environment precedence, rotation, and a 15-minute recovery-session audience
that is cryptographically distinct from full Admin SPA sessions.

**Acceptance criteria:**

- [ ] Environment token wins over the local hash and comparisons are
  constant-time and rate-limited.
- [ ] Recovery tokens/sessions are never accepted by `requireAdmin`, API-key, or
  model authentication.
- [ ] Rotation returns a token once and returns
  `recovery_token_env_managed` when environment-controlled.

**Verification:**

- [ ] RED then GREEN: focused auth primitive/session tests.
- [ ] Existing admin setup, login, logout, and token rotation tests pass.

**Dependencies:** H1.1

**Files likely touched:**

- `src/lib/runtime-config.ts`
- `src/lib/admin-auth.ts`
- `src/lib/recovery-sessions.ts`
- `src/__tests__/admin-auth.test.ts`

**Estimated scope:** M

### Task H1.6: Mount recovery login and capability middleware

**Description:** Implement recovery login, token rotation, recovery bearer
verification, exact route allowlisting, and audience isolation without widening
the existing `requireAdmin` middleware.

**Acceptance criteria:**

- [ ] Recovery login returns the typed `scope: recovery` receipt with a 15-minute
  expiry.
- [ ] The recovery bearer reaches only the allowlisted recovery routes.
- [ ] Ordinary admin and model routes reject the recovery bearer before handler
  execution.

**Verification:**

- [ ] RED then GREEN: focused route matrix in `admin-auth.test.ts` and
  `spa-routes.test.ts`.
- [ ] `npm.cmd run typecheck`.

**Dependencies:** H1.5

**Files likely touched:**

- `src/routes/auth.ts`
- `src/middleware/requireRecovery.ts`
- `src/app.ts`
- `src/__tests__/admin-auth.test.ts`
- `src/__tests__/spa-routes.test.ts`

**Estimated scope:** M

### Task H1.7: Add recovery storage health and capability APIs

**Description:** Add masked storage health, a cache-free full capability test,
and a recovery-scoped storage repair update. Keep the existing normal admin
settings lifecycle compatible.

**Acceptance criteria:**

- [ ] Capability testing reports every required table/status in one bounded,
  field-addressable response.
- [ ] Request-supplied bootstrap secrets are never persisted during test and are
  absent from errors/logs.
- [ ] Recovery update uses the dedicated discriminated DTO: persisted Supabase
  URL, credential `retain|replace`, and storage mode `retain|switch_to_sql` only.
- [ ] Environment-managed Supabase credentials reject API replacement with 409
  `credential_env_managed`; locally managed replacements encrypt into the local
  recovery vault.
- [ ] Secret clear, local encryption-key mutation/rotation, unrelated settings,
  arbitrary modes, and unsafe transitions are structurally impossible or
  rejected before persistence.

**Verification:**

- [ ] RED then GREEN: focused recovery storage API tests.
- [ ] Existing Settings storage, schema, and admin-auth tests pass.

**Dependencies:** H1.1, H1.4, H1.6

**Files likely touched:**

- `src/routes/settings.ts`
- `src/lib/supabase-schema.ts`
- `src/app.ts`
- `src/__tests__/storage-recovery.test.ts`

**Estimated scope:** M

### Task H1.8: Production recovery documentation and release gate

**Description:** Document the recovery token and schema procedure, add the
standalone additive Tools migration, and execute the full H1A/H1B verification matrix
before the VPS restarts.

**Acceptance criteria:**

- [ ] `.env.example` and deployment docs explain `HELMORA_RECOVERY_TOKEN`, schema
  application, masked health, and rollback.
- [ ] The additive migration is standalone/idempotent and the full schema remains
  the source of truth.
- [ ] The production regression test proves the original missing-table crash now
  boots degraded and exposes recovery endpoints.

**Verification:**

- [ ] `npm.cmd test`.
- [ ] `npm.cmd run typecheck`.
- [ ] `npm.cmd run build`.
- [ ] `git diff --check` and staged secret scan.

**Dependencies:** H1.1--H1.7

**Files likely touched:**

- `.env.example`
- `README.md`
- `docs/deploy.md`
- `sql/migrations/004_tools_control_plane.sql`
- `sql/migrations/README.md`

**Estimated scope:** M

## Checkpoint H1B -- Safe to Restart VPS With Recovery

- [ ] Missing Supabase tables and remote outages do not crash a Hub with a valid
  local snapshot.
- [ ] Serving readiness does not wait for a long remote timeout when the snapshot
  is valid; recovery-only mode remains live but `/ready` stays 503.
- [ ] Recovery authentication and route isolation pass the complete matrix.
- [ ] No-snapshot serving fails closed with a repair path.
- [ ] Full Hub tests, typecheck, build, schema checks, and secret scan pass.
- [ ] H1A/H1B are committed as small rollback-friendly increments and ready for the
  user's push/deployment.

## H2 -- Transactional Outbox

### Task H2.1: Version the local operation ledger

**Description:** Add typed write-ahead envelopes, idempotency-key hashes,
fingerprints, causal groups, status, leases, fencing, and operation receipts to
SQLite. Migrate current outbox rows without assuming they are exactly-once.

**Acceptance criteria:**

- [ ] Local intent plus effective overlay commit in one SQLite transaction.
- [ ] Same idempotency key/fingerprint returns one operation; mismatched reuse
  returns 409 before persistence.
- [ ] Dedupe scope is authenticated actor plus normalized route/action plus key;
  canonical fingerprint binds method, route/action, actor, entity identity, and
  normalized validated body rather than raw JSON.
- [ ] Applied receipts remain for 30 days; pending/conflict receipts remain until
  resolved and then 30 days; cleanup is bounded to 500 terminal rows per pass.
- [ ] Orphaned replay leases recover to pending after restart.

**Verification:**

- [ ] Focused operation-ledger and migration tests.
- [ ] Existing outbox tests remain green.

**Dependencies:** H1B checkpoint

**Files likely touched:**

- `src/storage/control-plane.ts`
- `src/storage/control-vault.ts`
- `src/storage/control-mutations.ts`
- `src/__tests__/control-mutations.test.ts`

**Estimated scope:** M

### Task H2.2: Add the Supabase idempotent mutation RPC

**Description:** Add the remote operation ledger, revisions, and transactional
RPC that deduplicates by operation ID and returns a canonical public result.

**Acceptance criteria:**

- [ ] Repeating one operation ID never increments revision or mutates twice.
- [ ] One operation applies its logical records and ledger result atomically.
- [ ] Same operation ID with a different fingerprint fails as a conflict.

**Verification:**

- [ ] SQL assertions and mocked Supabase mutation tests.
- [ ] Full schema and standalone migration stay idempotent.

**Dependencies:** H2.1

**Files likely touched:**

- `sql/supabase-schema.sql`
- `sql/migrations/005_control_mutation_ledger.sql`
- `src/storage/supabase-store.ts`
- `src/__tests__/supabase-schema.test.ts`

**Estimated scope:** M

### Task H2.3: Make Admin SPA saves idempotent

**Description:** Add a frontend logical-save idempotency helper. It creates one
UUID when a save begins, reuses it across transport and ambiguous retries, and
releases it only after a terminal response or a materially changed draft.

**Acceptance criteria:**

- [ ] The same unchanged logical save reuses one `Idempotency-Key` across network
  errors, timeouts, reload-safe retry state where supported, and manual Retry.
- [ ] A terminal success/rejection or changed normalized draft starts a new
  logical-save scope; renders and duplicate clicks do not.
- [ ] Mutation API helpers attach the key consistently without logging it or
  coupling components to request-fingerprint implementation details.

**Verification:**

- [ ] Focused pure-helper tests if the existing frontend runner supports them;
  otherwise deterministic helper fixtures plus lint/build and browser network
  inspection for ambiguous retry behavior.
- [ ] Helmora-Frontend `npm.cmd run lint` and `npm.cmd run build`.

**Dependencies:** H2.1--H2.2

**Files likely touched:**

- `Helmora-Frontend/src/lib/api/idempotency.ts`
- `Helmora-Frontend/src/lib/api/client.ts`
- `Helmora-Frontend/src/lib/api/hub.ts`
- Relevant draft/save hooks in `Helmora-Frontend/src/features/*`

**Estimated scope:** M

### Task H2.4: Coordinate non-secret control writes

**Description:** Route settings, agents, routing metadata, and other non-secret
control changes through the local write-ahead coordinator and remote RPC. Secret
mutations remain online-only/fail closed until H4.

**Acceptance criteria:**

- [ ] Online, ambiguous-timeout, and degraded paths reuse one operation ID.
- [ ] Pending local overlays remain effective without mutating the base snapshot.
- [ ] Secret mutation attempts while degraded return
  `control_secret_offline_unavailable` until H4.

**Verification:**

- [ ] Focused vertical-slice tests for settings and agents.
- [ ] Existing Mini/Tools configuration tests remain green.

**Dependencies:** H2.1--H2.3

**Files likely touched:**

- `src/storage/control-mutations.ts`
- `src/storage/hybrid-store.ts`
- `src/routes/settings.ts`
- `src/routes/admin.ts`
- `src/__tests__/hybrid-control-mutations.test.ts`

**Estimated scope:** M

### Task H2.5: Run the restart-safe reconciler

**Description:** Add the single background reconciler with probing,
causal/dependency ordering, leases, fencing, backoff, shutdown, and request-write
serialization.

**Acceptance criteria:**

- [ ] Request writes remain local-only during degraded/probing/reconciling.
- [ ] Conflict blocks its causal group but unrelated entities continue.
- [ ] Restart and expired leases resume without duplicate remote application.

**Verification:**

- [ ] Focused scheduler, lease, conflict, and concurrency tests.
- [ ] Existing Hybrid reconcile tests remain green or are migrated explicitly.

**Dependencies:** H2.1--H2.4

**Files likely touched:**

- `src/storage/control-plane.ts`
- `src/storage/hybrid-store.ts`
- `src/storage/control-reconciler.ts`
- `src/storage/index.ts`
- `src/__tests__/hybrid-store-reconcile.test.ts`

**Estimated scope:** M

## Checkpoint H2 -- Exactly-Once Non-Secret Control

- [ ] Admin SPA logical saves, client retries, and remote retries are idempotent.
- [ ] Reconciler survives restart and cannot race request remote writes.
- [ ] Secret operations fail closed until H4.
- [ ] Full Hub verification passes.

## H3 -- Atomic Complete Mirror

### Task H3.1: Stage and atomically activate snapshot generations

**Description:** Expand the H1 manifest into complete staging generations,
manifest validation, atomic activation, incomplete-generation discard, and
bounded garbage collection.

**Acceptance criteria:**

- [ ] Runtime reads only one complete active generation plus operation overlays.
- [ ] A partial/crashed refresh never changes the active generation.
- [ ] Remote deletion is recognized only through a complete new generation.

**Verification:**

- [ ] Focused generation crash/activation/deletion tests.
- [ ] Offline restart tests remain green.

**Dependencies:** H2 checkpoint

**Files likely touched:**

- `src/storage/control-vault.ts`
- `src/storage/control-snapshots.ts`
- `src/storage/hybrid-store.ts`
- `src/__tests__/control-snapshots.test.ts`

**Estimated scope:** M

### Task H3.2: Refresh the complete control projection

**Description:** Stage providers, API-key records, agents, settings, Mini, Tools,
pricing, modes, and routing metadata as one validated generation.

**Acceptance criteria:**

- [ ] Every required capability is present in the manifest before activation.
- [ ] Cross-entity references and encrypted envelopes validate before switch.
- [ ] Newer pending overlays remain effective after snapshot activation.
- [ ] API-key hashes, budgets, and lifecycle state support degraded/offline auth
  reads, but create/rotate/revoke/budget mutations remain online-only and fail
  closed until H4.

**Verification:**

- [ ] Complete/partial capability refresh integration tests.
- [ ] Existing provider, Mini, Tools, and pricing tests remain green.

**Dependencies:** H3.1

**Files likely touched:**

- `src/storage/control-snapshots.ts`
- `src/storage/hybrid-store.ts`
- `src/storage/supabase-store.ts`
- `src/__tests__/hybrid-snapshot-refresh.test.ts`

**Estimated scope:** M

### Task H3.3: Make the model catalog Supabase-primary

**Description:** Add stable model catalog tables/store methods, complete snapshot
projection, provider dependency validation, and pointer revisions.

**Acceptance criteria:**

- [ ] Online catalog changes write through the control mutation contract.
- [ ] The local mirror serves `/models` during degraded mode.
- [ ] Default/benchmark pointers use CAS and cannot silently target missing rows.

**Verification:**

- [ ] Focused Supabase catalog and degraded mirror tests.
- [ ] Existing model-catalog and Mini delete-guard tests remain green.

**Dependencies:** H3.1--H3.2

**Files likely touched:**

- `src/storage/supabase-store.ts`
- `src/storage/hybrid-store.ts`
- `src/models/types.ts`
- `sql/supabase-schema.sql`
- `src/__tests__/model-catalog.test.ts`

**Estimated scope:** M

### Task H3.4: Import catalog data and surface conflicts

**Description:** Import SQLite catalog data only when Supabase is empty; when
both contain data, preserve both and require an explicit source decision.

**Acceptance criteria:**

- [ ] Empty-remote import preserves stable catalog IDs and provider references.
- [ ] Dual-populated stores never auto-overwrite and expose a masked conflict.
- [ ] Same-field revision conflicts block dependents while unrelated groups
  reconcile.

**Verification:**

- [ ] Focused import, source-choice, and field-conflict tests.
- [ ] Full model/route regression tests pass.

**Dependencies:** H3.3

**Files likely touched:**

- `src/storage/model-catalog-migration.ts`
- `src/storage/hybrid-store.ts`
- `src/routes/admin.ts`
- `src/__tests__/model-catalog-migration.test.ts`

**Estimated scope:** M

## Checkpoint H3 -- Complete Supabase-Primary Control Mirror

- [ ] Runtime never sees a mixed snapshot generation.
- [ ] All runtime-critical non-secret control data is available offline.
- [ ] `/models` is Supabase-primary with explicit conflict handling.
- [ ] Full Hub verification passes.

## H4 -- Secret Entities and OAuth

### Task H4.1: Version portable credential envelopes

**Description:** Add remote/local key identities, encryption version, nonce,
entity-bound AAD, in-memory re-encryption, and resumable key rotation.

**Acceptance criteria:**

- [ ] Ciphertext cannot be substituted across entity/type/schema identity.
- [ ] Decrypted remote credential material exists only transiently in memory
  inside the credential boundary. Supabase and SQLite store only
  ciphertext/envelope.
- [ ] Legacy plaintext vault payloads migrate atomically or fail closed.

**Verification:**

- [ ] Focused provider/connector/OAuth envelope and migration tests.
- [ ] Staged secret scan finds no plaintext fixture outside explicit tests.

**Dependencies:** H3 checkpoint

**Files likely touched:**

- `src/lib/crypto.ts`
- `src/storage/credential-envelope.ts`
- `src/storage/control-vault.ts`
- `src/__tests__/credential-envelope.test.ts`

**Estimated scope:** M

### Task H4.2: Reconcile provider and connector credentials atomically

**Description:** Move provider plus credential and connector credential
rotate/clear onto encrypted logical mutation RPCs and local envelopes.

**Acceptance criteria:**

- [ ] Provider state never indicates connected/configured without usable
  matching credential material.
- [ ] Rotate/clear operations are never compacted and replay exactly once.
- [ ] Remote outage serves valid local secrets without exposing them through DTOs.

**Verification:**

- [ ] Focused provider and connector online/degraded/reconcile tests.
- [ ] Existing TinyFish credential and connector tests remain green.

**Dependencies:** H4.1

**Files likely touched:**

- `src/storage/hybrid-store.ts`
- `src/storage/supabase-store.ts`
- `src/storage/control-mutations.ts`
- `src/__tests__/connector-vault.test.ts`
- `src/__tests__/provider-credential-hybrid.test.ts`

**Estimated scope:** M

### Task H4.3: Move API-key control records and delivery envelopes

**Description:** Make API-key hash/budget/lifecycle one logical control entity and
add the local encrypted 10-minute plaintext delivery envelope for idempotent
create retries.

**Acceptance criteria:**

- [ ] Create/revoke/budget changes apply remotely once by operation ID.
- [ ] Delivery envelope is local-only/encrypted and bound to actor ID, operation
  ID, idempotency-key hash, and created key hash.
- [ ] The same actor/key may retrieve the same plaintext repeatedly until expiry,
  including after restart; it cannot be listed or fetched by API-key ID alone.
- [ ] `deliveredAt` records delivery without deleting the envelope, and every
  delivery attempt emits a redacted audit event.
- [ ] Bounded cleanup removes envelopes only after the 10-minute expiry.
- [ ] Expired delivery returns `secret_delivery_expired` without creating a new
  key.

**Verification:**

- [ ] Focused repeated-delivery, actor/key mismatch, non-listability, restart,
  delivery-audit, expiry cleanup, and ambiguous-timeout tests.
- [ ] Existing API-key budget/auth tests remain green.

**Dependencies:** H4.1

**Files likely touched:**

- `src/storage/api-key-control.ts`
- `src/storage/hybrid-store.ts`
- `src/routes/keys.ts`
- `src/__tests__/api-key-hybrid.test.ts`

**Estimated scope:** M

### Task H4.4: Enable Hybrid OAuth logical transactions

**Description:** Remove the `SqliteConfigStore` type restriction and reconcile
OAuth bundle, auth mode, and connected state atomically. Keep pending PKCE local,
encrypted, and expiry-bound.

**Acceptance criteria:**

- [ ] Hybrid OAuth start/callback/refresh/disconnect no longer rejects the store
  type.
- [ ] Bundle plus provider flags commit as one logical remote operation.
- [ ] Pending PKCE never syncs to Supabase and expires correctly after restart.

**Verification:**

- [ ] Focused Hybrid OAuth route/vault/reconcile tests.
- [ ] Existing Claude/Codex OAuth suites remain green.

**Dependencies:** H4.1--H4.2

**Files likely touched:**

- `src/oauth/create-core.ts`
- `src/oauth/resolve-provider-auth.ts`
- `src/oauth/vault.ts`
- `src/storage/hybrid-store.ts`
- `src/__tests__/oauth-routes.test.ts`

**Estimated scope:** M

### Task H4.5: Final observability and rollout review

**Description:** Expose masked generation/outbox/conflict health, verify state
transition logging, update operational docs, and run the complete outage matrix.

**Acceptance criteria:**

- [ ] Health exposes state, snapshot age/generation, probe time, and operation
  counts without payloads or secrets.
- [ ] Logs emit normalized transitions once and no repeated raw upstream errors.
- [ ] Supabase outage, restart, replay, conflict, and recovery drills pass.

**Verification:**

- [ ] `npm.cmd test`.
- [ ] `npm.cmd run typecheck`.
- [ ] `npm.cmd run build`.
- [ ] `git diff --check` and staged secret scan.

**Dependencies:** H4.1--H4.4

**Files likely touched:**

- `src/storage/control-plane.ts`
- `src/routes/settings.ts`
- `README.md`
- `docs/deploy.md`
- `src/__tests__/control-health-status.test.ts`

**Estimated scope:** M

## Final Checkpoint

- [ ] All approved design success criteria are demonstrated.
- [ ] H1A remains independently deployable only under its explicit production
  snapshot/no-recovery release gate; H1B remains rollback-safe.
- [ ] H2--H4 schema changes are additive and idempotent.
- [ ] Local-only SQLite mode remains compatible.
- [ ] Tools runtime resumes only after Hybrid control health is stable.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| H1A accidentally treats partial mirror data as complete | High | Exact tiered generation-zero algorithm, trusted source marker, and atomic manifest/pointer |
| Recovery bearer reaches ordinary admin routes | High | Separate audience, middleware, route matrix, and short TTL |
| Remote commit times out after success | High | Client idempotency key plus remote operation ledger in H2 |
| Snapshot refresh exposes mixed generations | High | Staging plus atomic active-generation switch in H3 |
| Secret payload enters generic JSON outbox | High | Secret mutations fail closed until H4 envelope support |
| Catalog migration overwrites existing remote data | High | Empty-only import and explicit source conflict |
| Existing Tools work regresses during storage changes | Medium | Keep runtime disabled/paused and rerun focused Tools suites |
| Plan tasks overlap dirty cloudflared work | Low | Dedicated Hybrid plan and separate atomic commits |

## Commit Boundaries

- H1.1--H1.2 (H1A): capability classification and local completeness foundation.
- H1.3--H1.4 (H1A): boot survival and liveness/readiness gating.
- H1.5--H1.7 (H1B): recovery authentication and storage repair surface.
- H1.8 (H1B): schema/docs/full release gate.
- H2 includes a separate Helmora-Frontend idempotency commit; remaining H2, H3,
  and H4 use one reviewed commit per task unless a SQL migration must be
  separated for operational rollout.

## Open Questions

None. Implementation begins with a failing H1.1/H1.3 production regression
test after this revised plan is approved.
