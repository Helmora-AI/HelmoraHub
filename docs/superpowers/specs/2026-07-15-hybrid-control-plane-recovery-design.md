# Hybrid Control Plane Recovery Design

**Date:** 2026-07-15
**Status:** Proposed for review
**Surface:** HelmoraHub storage, Supabase schema, admin storage health

## Objective

Make Hybrid storage match Helmora's intended operational model:

- Supabase is the primary control plane for configuration and credentials.
- SQLite on the VPS stores workspace data and an encrypted, runtime-usable
  control-plane mirror.
- Supabase outages never prevent Hub boot when a local mirror is available.
- Offline control-plane changes are durably logged and replay automatically in
  the correct order when Supabase returns.

This work precedes the controlled `cloudflared` startup update.

## Data Ownership

### Supabase-primary control plane

- Providers, routing metadata, provider API credentials, and verification state.
- Helmora client API-key hashes, budgets, and lifecycle state.
- Agents, modes, Mini routing, Tools runtime, pricing, and other runtime settings.
- Connector credentials such as TinyFish.
- OAuth credential bundles and provider OAuth state.
- The first-class `/models` catalog, including default and benchmark pointers.

Every control-plane entity required at runtime has a local encrypted mirror.

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

1. Load the last local control snapshot and pending outbox.
2. Validate Supabase connectivity and all required schema capabilities.
3. Bootstrap and refresh the mirror when the remote control plane is ready.
4. If Supabase is unreachable, unauthorized, throttled, or missing required
   additive tables, mark the control plane `degraded`, retain a public-safe
   reason, and continue boot from the local mirror.
5. Local database corruption, an unusable encryption key, or an invalid local
   vault remains fatal; degraded mode must not conceal local integrity failure.

A first deployment without any usable local snapshot may boot only far enough
to expose authenticated recovery/settings surfaces. Model-serving routes return
a clear `control_snapshot_unavailable` response until the remote schema or
snapshot is restored.

## Schema Readiness and Migrations

The Settings connection test probes every table/capability used by the active
Hybrid runtime, not only `helmora_settings`. It returns all missing capabilities
in one field-addressable response.

Existing installations receive a standalone additive migration for Tools
control tables. The full `sql/supabase-schema.sql` remains the idempotent source
of truth. Applying DDL is an explicit administrator operation; Hub never runs
arbitrary schema DDL through runtime credentials.

Schema mismatch is a degraded health reason and admin warning, not an
unhandled boot exception.

## Online Reads and Writes

When online, Supabase is authoritative for control-plane reads and writes.
Every successful write updates the local mirror before returning success. A
remote write followed by mirror failure returns an explicit durability error
rather than claiming the operation is safely backed up.

Workspace reads and writes always use SQLite regardless of control-plane state.

## Failure Transition and Offline Writes

Remote failures are classified. Transport, timeout, retryable upstream,
credentials/access, and schema-readiness failures may enter degraded mode;
local validation and encryption failures do not.

The operation that discovers remote unavailability is not lost:

1. Attempt the remote write while online.
2. On a degradable failure, atomically apply the intended mutation to the local
   mirror and append its outbox operation.
3. Return success with degraded synchronization metadata when local commit
   succeeds.
4. Return failure only when neither the remote write nor the durable local
   commit succeeds.

All subsequent degraded writes use the same local transaction plus outbox
boundary.

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
payload, base revision, created time, attempt count, last attempt time,
normalized error code, and applied time. Raw upstream errors and plaintext
credentials are never stored or returned.

Operations remain idempotent by operation ID. Applied history is retained for a
bounded diagnostic window; safe compaction may fold superseded pending
operations for the same entity without changing their final meaning.

## Automatic Recovery

A single background reconciler owns remote probes and replay. It starts after
storage initialization, uses bounded exponential backoff with jitter, prevents
overlapping runs, and stops cleanly during Hub shutdown.

Recovery order is:

```text
degraded
-> remote capability probe
-> reconciling
-> replay pending operations in sequence
-> refresh complete control snapshot
-> verify local mirror durability
-> online
```

Failure leaves the current and remaining operations retryable and returns the
state to degraded. A restart resumes from the durable outbox and persisted
plane metadata.

## Conflict Policy

The current Pterodactyl deployment is single-writer: control-plane mutations
must go through this Hub. Offline operations use monotonic local sequence and
win for the fields they explicitly change.

Control records gain a revision. Each offline patch records its base revision.
If the remote revision changed unexpectedly, replay does not overwrite it
silently. Non-overlapping patches may merge; same-field changes become
`conflict` and remain visible for administrator resolution. Direct Supabase
editing while Hub is offline is therefore detectable rather than silently lost.

## Complete Mirror Requirements

Refreshing the mirror includes all runtime-critical settings and entities, not
only `active_mode`. At minimum it covers:

- Provider and agent records.
- Helmora API-key records.
- Connector and OAuth credentials as ciphertext.
- Mini, Tools, pricing, mode, and routing settings.
- The `/models` catalog and its pointers.

Deletion is mirrored explicitly. A partial refresh never deletes the last good
local value for an entity whose remote capability could not be read.

## Credential Safety

- Provider API keys are encrypted in Supabase and remain encrypted in SQLite.
- Connector and OAuth secrets remain encrypted end to end.
- Offline Helmora client API-key creation persists only its one-time plaintext
  response to the caller; synchronization uses a pre-hashed record or encrypted
  transient payload, never plaintext outbox JSON.
- Secret-bearing mirror migrations replace any legacy plaintext vault payloads
  atomically after validation.
- Logs, health payloads, state transitions, and sync errors contain IDs and
  normalized codes only.

## Model Catalog

The `/models` catalog becomes Supabase-primary. Online catalog mutations write
the control plane and then update the local SQLite mirror. Degraded mutations
write the mirror and enqueue a catalog patch/snapshot operation. Replay preserves
stable catalog IDs and validates provider references before marking applied.

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
operation so a provider cannot appear connected without a usable credential.

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
- Invalid/corrupt local SQLite or encryption state remains fatal.
- Settings connection test reports every missing required table.
- The write that triggers degradation is committed locally and queued exactly
  once.
- Restart resumes persisted plane/outbox state and automatic reconciliation.
- Replay is ordered, idempotent, bounded, and non-overlapping.
- Retry failure leaves unapplied operations pending with safe diagnostics.
- Complete settings and model catalog snapshots survive offline restart.
- Provider, connector, OAuth, and API-key outboxes contain no plaintext secret.
- Revision conflict prevents silent same-field overwrite.
- Chat, usage, and tool activity remain SQLite-only.

## Rollout

1. Apply the idempotent Supabase schema/additive Tools migration.
2. Ship boot-degraded behavior and complete schema probing.
3. Ship complete encrypted mirror and automatic reconciler.
4. Migrate `/models` to Supabase primary with explicit conflict handling.
5. Enable Hybrid OAuth synchronization.
6. Verify outage, restart, replay, and conflict scenarios before resuming Tools
   runtime implementation.

Each increment is rollback-friendly and leaves existing local-only SQLite mode
unchanged.

## Success Criteria

- Supabase outage or additive schema lag cannot crash a Hub with a valid local
  snapshot.
- Runtime control data remains usable offline without exposing plaintext
  credentials.
- Every accepted offline mutation has a durable visible sync state.
- Reconnection automatically replays and refreshes without manual process
  restart.
- `/models` is Supabase-primary and remains available from its local mirror.
- Hybrid OAuth uses encrypted primary and mirror credentials.
- Workspace chat, usage, and tool activity never move to Supabase.
- Local-only storage behavior remains compatible.

## Open Questions

None.
