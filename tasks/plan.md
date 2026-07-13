# Implementation Plan: Helmora Mini 1.0 Role Router

## Overview

Implement the approved role-based Helmora Mini 1.0 design across HelmoraHub and Helmora-Frontend. The work proceeds from deterministic classification and versioned configuration through exact catalog routing, observability, catalog protection, and finally the role-card Admin SPA. Every behavioral slice begins with a failing Hub test and leaves existing non-Mini routes working.

## Architecture Decisions

- Store stable catalog IDs in six fixed role assignments; resolve provider/model identity at runtime.
- Inherit missing specialist slots independently from `general`, deduplicate, and cap the attempt list at two.
- Classify only user-authored conversation content; never classify system, identity, compression, or provider context.
- Normalize retry behavior into an explicit cross-model retry decision before Mini advances slots.
- Keep `helmora-mini-1.0` canonical and `auto` as a compatibility alias.
- Preserve Helmora Mini public identity while operational details remain in headers, usage, logs, and authenticated admin data.
- Remove Office only from the Admin SPA information architecture; do not delete the external Office project or endpoint.
- Follow `Helmora-Frontend/DESIGN.md` and the approved role-card layout.

## Dependency Graph

```text
Classifier + role types
        │
        ├── Version 2 config + migration + effective slots
        │       ├── Admin GET/PUT contract
        │       └── Catalog delete guard
        │
        └── Runtime catalog attempts + retry taxonomy
                ├── /v1 and admin-chat integration
                ├── streaming commit semantics
                └── headers + usage metadata + identity coordination
                                │
                                └── Frontend API types + role-card UI
```

## Task Details

### Task 1: Deterministic bilingual intent classifier

**Description:** Add fixed Mini role types and a pure classifier for English, accented Vietnamese, unaccented Vietnamese, thresholds, tie precedence, and continuation turns.

The classifier contract is explicit and stateless-safe:

```ts
type MiniClassifierInput = {
  latestUserText: string;
  previousUserText?: string;
  previousMiniRole?: MiniRole;
};
```

Selection policy:

1. If the latest message crosses a specialist threshold, use that new role.
2. If the latest message is a continuation with no specialist signal, retain a trusted `previousMiniRole` when provided.
3. Otherwise classify `previousUserText` at reduced weight.
4. Fall back to `general`.

Assistant and system content are never inputs to this contract.

**Acceptance criteria:**
- [ ] Only user-authored messages influence classification.
- [ ] All six outcomes, threshold behavior, ties, and continuation behavior are deterministic.
- [ ] Continuation precedence is latest specialist → previous Mini role → previous user intent → General.
- [ ] Assistant/system/identity text cannot enter the classifier or change the selected role.

**Verification:**
- [ ] RED then GREEN: `npm.cmd test -- src/__tests__/mini-classifier.test.ts`
- [ ] `npm.cmd run typecheck`

**Dependencies:** None

**Files likely touched:**
- `src/services/mini-classifier.ts`
- `src/__tests__/mini-classifier.test.ts`

**Estimated scope:** S

### Task 2: Version 2 role configuration and legacy migration

**Description:** Replace candidate normalization with version 2 role assignments, read legacy candidates non-destructively, and compute slot-wise effective assignments with warnings.

**Acceptance criteria:**
- [ ] Version 2 config normalizes all fixed roles and preserves `enabled`.
- [ ] Legacy candidates map to General primary/fallback when catalog rows exist.
- [ ] Effective slots inherit independently, remove duplicates, and never exceed two attempts.

**Verification:**
- [ ] RED then GREEN: focused `mini-route.test.ts` normalization/migration tests
- [ ] `npm.cmd run typecheck`

**Dependencies:** Task 1

**Files likely touched:**
- `src/services/mini-route.ts`
- `src/__tests__/mini-route.test.ts`
- `src/storage/types.ts` only if a catalog lookup helper is required

**Estimated scope:** M

### Task 3: Admin Mini API version 2 contract

**Description:** Update GET/PUT `/api/mini-route` to expose stored/effective role slots, catalog summaries, classifier metadata, migration warnings, and temporary-health warnings.

**Acceptance criteria:**
- [ ] GET returns the complete role configuration and field-addressable warnings.
- [ ] PUT rejects structurally invalid/non-provider catalog references and duplicate same-role slots.
- [ ] PUT accepts temporarily degraded static-eligible models and returns warnings.

**Verification:**
- [ ] RED then GREEN: focused Mini admin API tests
- [ ] Existing `spa-routes.test.ts` remains green

**Dependencies:** Task 2

**Files likely touched:**
- `src/routes/admin.ts`
- `src/services/mini-route.ts`
- `src/__tests__/mini-route.test.ts`
- `src/__tests__/spa-routes.test.ts`

**Estimated scope:** M

## Checkpoint: Configuration Foundation

- [ ] Classifier and config tests pass.
- [ ] Admin GET/PUT response matches the spec.
- [ ] `npm.cmd run typecheck` passes.
- [ ] Commit the foundation as one reviewable backend increment.

### Task 4: Protect referenced catalog models from deletion

**Description:** Extend model catalog deletion guards to enumerate Mini role/slot references and reject deletion with `409 model_in_use`. The guard reads normalized effective Mini configuration, including role references projected from legacy candidates that have not yet been persisted as version 2.

**Acceptance criteria:**
- [ ] Every stored Mini role/slot reference is returned in the error.
- [ ] Legacy candidate references are protected before the first version 2 save.
- [ ] Deletion never auto-clears Mini configuration.
- [ ] Unreferenced model deletion behavior remains unchanged.

**Verification:**
- [ ] RED then GREEN: focused `model-catalog.test.ts` delete-guard tests

**Dependencies:** Task 2

**Files likely touched:**
- `src/routes/admin.ts`
- `src/services/mini-route.ts`
- `src/__tests__/model-catalog.test.ts`

**Estimated scope:** M

### Task 5: Exact catalog attempt resolution and retry taxonomy

**Description:** Resolve the classified role into ordered catalog attempts and teach the routing layer to dispatch exact provider/model pairs with normalized retry decisions.

The routing layer consumes this typed contract rather than inferring policy directly from status classes:

```ts
type CrossModelRetryDecision = {
  retryable: boolean;
  reason:
    | 'network'
    | 'rate_limited'
    | 'upstream_unavailable'
    | 'invalid_credentials'
    | 'model_missing'
    | 'request_invalid'
    | 'context_limit'
    | 'unsupported_request';
  healthEffect: 'none' | 'degraded' | 'invalid_credentials';
};
```

The initial context-limit policy is non-retryable because sending the same oversized conversation to another configured model is not guaranteed to cure the request. A later capability-aware policy may override this per adapter/model.

**Acceptance criteria:**
- [ ] Mini attempts contain slot, catalog ID, provider, and upstream model.
- [ ] Retryable failures advance; deterministic request failures stop.
- [ ] Network, 429, 5xx, provider 401/403, and model 404 retry; malformed 400, unsupported 422, and context-limit stop.
- [ ] Provider 401/403 records `invalid_credentials` health effect before fallback.
- [ ] The global mode/provider chain is never appended to Mini attempts.

**Verification:**
- [ ] RED then GREEN: focused Mini routing and retry tests
- [ ] Existing tier-router/provider adapter tests remain green

**Dependencies:** Tasks 1–3

**Files likely touched:**
- `src/services/mini-route.ts`
- `src/services/tier-router.ts`
- `src/providers/dispatch.ts`
- `src/__tests__/mini-route.test.ts`
- `src/__tests__/adapters-p2.test.ts`

**Estimated scope:** M

### Task 6: Integrate Mini role routing into non-stream and stream requests

**Description:** Wire user-message classification and exact attempts into `/v1` and admin chat while preserving explicit catalog/mode routes. Define fallback only before the first visible streaming delta.

**Acceptance criteria:**
- [ ] `auto` and canonical Mini ID use identical role routing.
- [ ] Non-stream and stream use primary then fallback under the normalized policy.
- [ ] A stream never changes models after emitting visible content.

**Verification:**
- [ ] RED then GREEN: focused `sse.test.ts`, `admin-chat.test.ts`, and Mini integration tests
- [ ] Explicit `catalog/*` and `mode/*` regression tests pass

**Dependencies:** Task 5

**Files likely touched:**
- `src/routes/v1.ts`
- `src/routes/chat.ts`
- `src/services/tier-router.ts`
- `src/__tests__/sse.test.ts`
- `src/__tests__/admin-chat.test.ts`

**Estimated scope:** M

### Task 7: Identity and observability metadata

**Description:** Preserve canonical Mini identity, expose role/slot headers and error metadata, and record Mini dimensions in usage storage.

**Acceptance criteria:**
- [ ] Identity is injected after classification and exactly once per attempt.
- [ ] A fallback rebuilds a fresh upstream message envelope and replaces identity context; it never appends a second identity message to the prior attempt's envelope.
- [ ] CORS exposes `X-Helmora-Mini-Role` and `X-Helmora-Mini-Slot`; route tests assert the actual `Access-Control-Expose-Headers` value.
- [ ] Success headers are readable through CORS; failure bodies contain public-safe Mini metadata.
- [ ] Usage stores nullable role, slot, and catalog ID across supported storage backends.

**Verification:**
- [ ] RED then GREEN: identity-context, usage, SQLite/Supabase schema, and API header tests
- [ ] SQL schema assertions pass

**Dependencies:** Task 6

**Files likely touched:**
- `src/services/identity-context.ts`
- `src/routes/v1.ts`
- `src/routes/chat.ts`
- `src/storage/types.ts`
- `src/storage/sqlite-store.ts`
- Storage schema/migration files may form a separate atomic sub-commit if needed

**Estimated scope:** M, split storage migration if it exceeds five files

## Checkpoint: Runtime Complete

- [ ] All focused Mini, chat, SSE, catalog, identity, and usage tests pass.
- [ ] Full Hub test suite passes with isolated auth environment.
- [ ] Hub typecheck and production build pass.
- [ ] Commit runtime and storage changes in reviewable increments.

### Task 8: Frontend API types and direct Agents route

**Description:** Adopt the version 2 API contract in Helmora-Frontend and make `/agents` render Mini directly while removing Office from the Admin SPA route tree.

**Acceptance criteria:**
- [ ] Frontend types represent stored/effective role slots and warnings.
- [ ] `/agents/mini` redirects to `/agents`; `/agents/office` is absent.
- [ ] External Office codebase and Hub endpoint are untouched.

**Verification:**
- [ ] `npm.cmd run lint`
- [ ] `npm.cmd run build`

**Dependencies:** Task 3

**Files likely touched:**
- `src/types/api.ts`
- `src/lib/api/hub.ts`
- `src/app/router.tsx`
- `src/features/agents/AgentsLayout.tsx`

**Estimated scope:** M

### Task 9: Role-card configuration UI

**Description:** Rebuild the Mini page as six responsive role cards with searchable model selectors, effective routing, status/warning feedback, and draft save/discard behavior.

Keep draft behavior outside the React component in pure helpers such as:

```ts
buildEffectiveRolePreview()
validateMiniDraft()
isMiniDraftDirty()
buildRoleWarnings()
```

These helpers own duplicate primary/fallback validation, slot inheritance summaries, dirty comparison, same-provider warnings, and stale selection mapping. The component owns rendering, query/mutation state, and user events.

**Acceptance criteria:**
- [ ] Six cards follow `DESIGN.md`, dual themes, and `3 → 2 → 1` responsiveness.
- [ ] Stored, inherited, degraded, and same-provider states are understandable without relying on color alone.
- [ ] Draft validation, effective preview, dirty detection, and warnings live in pure helpers rather than component branches.
- [ ] Dirty actions are sticky; save is atomic and disabled for unchanged/invalid drafts.

**Verification:**
- [ ] `npm.cmd run lint` with no new warnings
- [ ] `npm.cmd run build`
- [ ] Browser verification: light/dark, desktop/tablet/mobile, loading/error/dirty/save/stale states

**Dependencies:** Tasks 3 and 8

**Files likely touched:**
- `src/features/agents/MiniRoutePage.tsx`
- `src/features/agents/agentsShared.ts`
- `src/features/agents/miniRouteDraft.ts`
- `src/app/AppShell.css`
- `src/types/api.ts`

**Estimated scope:** M

### Task 10: Final compatibility and quality review

**Description:** Run the full verification matrix, review the combined diffs, and update documentation that still describes Office-first Agents or the legacy candidate chain.

**Acceptance criteria:**
- [ ] All spec success criteria are demonstrated.
- [ ] No unrelated code or generated output is included.
- [ ] README/design route descriptions no longer contradict the shipped Agents surface.

**Verification:**
- [ ] HelmoraHub: full tests, typecheck, build
- [ ] Helmora-Frontend: lint, build, browser smoke
- [ ] `git diff --check` in both repositories

**Dependencies:** Tasks 1–9

**Files likely touched:**
- Relevant README/docs only where behavior changed

**Estimated scope:** S

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Existing router assumes one model pin per provider | High | Introduce explicit catalog attempts rather than overloading `modelByProvider` |
| Streaming adapters expose success before a visible delta | High | Add a focused first-visible-chunk contract and tests before route integration |
| Usage schema touches multiple storage backends | High | Split storage migration into its own verified subtask/commit |
| Legacy candidate mapping cannot find catalog IDs | Medium | Non-destructive read migration plus explicit admin warnings |
| Temporary provider health makes UI appear stale | Medium | Separate static eligibility from runtime status and preserve selected items |
| `auto` behavior surprises legacy clients | Medium | Canonical compatibility tests and rollout documentation |
| Frontend has no test runner | Medium | Keep UI state logic small; require lint/build plus real-browser state verification |

## Open Questions

None. Deferred follow-ups are optimistic config revisions/CAS and a Test Classification UI.
