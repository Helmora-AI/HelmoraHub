# Implementation Plan: Helmora Tools Runtime and Playground

## Overview

Implement the approved Tools design as rollback-friendly vertical slices across HelmoraHub and Helmora-Frontend. The rollout starts with safe Playground Markdown, then establishes immutable tool/configuration contracts and encrypted connector credentials, ships a disabled-by-default `/tools` control plane, proves TinyFish Search and Fetch in isolation, and only then integrates bounded tool loops into model routing. Every backend behavior begins with a failing test, and incomplete runtime functionality remains disabled by default.

## Architecture Decisions

- Keep built-in connector and tool identity, schemas, and risk in server-owned immutable code; persist only enablement, scopes, limits, caches, and orchestrator catalog IDs.
- Keep TinyFish credentials out of `tool_runtime_v1`; store encrypted connector credentials through explicit SQLite, Supabase, and hybrid control-vault/outbox methods.
- Treat TinyFish, model plans, fetched content, and model tool calls as untrusted input at every boundary.
- Resolve answer routing before projecting eligible tools; tools never switch the selected answer model or append an implicit provider chain.
- Default Tools to disabled after upgrade. Playground and Mini use `auto` only after enablement; explicit catalog/mode/direct routes remain `off` unless requested.
- Use process-local bounded limiter/cache for the current single-instance deployment and document that it is not account-wide across replicas.
- Meter every planner and answer model round separately with root-request lineage and no aggregate duplicate cost row.
- Keep public OpenAI streaming compatible: only SSE comments during internal work, followed by ordinary chunks and `[DONE]`.
- Defer write connectors, approval/resume, generic executable connectors, DuckDuckGo, schedules, and webhooks.

## Dependency Graph

```text
Safe Playground Markdown (independent)

Registry + config contracts
        ├── connector credential vault
        │       └── admin Tools API + /tools UI
        ├── TinyFish Search connector
        ├── TinyFish Fetch + SSRF defense
        └── limiter/cache/retry + audit
                    │
Request policy + eligible projection
                    │
Canonical bounded tool loop
        ├── native provider translation
        └── catalog orchestrator fallback
                    │
/v1 + admin chat integration
        ├── activity UI
        ├── public SSE/CORS diagnostics
        └── usage lineage
```

## Task Details

### Task 1: Safe assistant Markdown in Playground

**Description:** Render assistant messages with `react-markdown` and `remark-gfm` while user messages remain plain text. Add explicit component and URL policies, suppress images/raw HTML, bound rendered input, and style Markdown with existing tokens.

**Acceptance criteria:**
- [ ] Bold, emphasis, lists, tables, links, inline code, and fenced code render correctly without raw markers.
- [ ] Raw HTML and images do not execute/render; unsafe protocols are not link targets.
- [ ] Streaming updates preserve the existing message/bubble identity and remain readable.

**Verification:**
- [ ] `npm.cmd run lint`
- [ ] `npm.cmd run build`
- [ ] Browser smoke: final/incomplete Markdown, unsafe HTML/link/image, code overflow, light/dark/mobile

**Dependencies:** None

**Files likely touched:**
- `Helmora-Frontend/package.json`
- `Helmora-Frontend/package-lock.json`
- `Helmora-Frontend/src/features/chat/AssistantMarkdown.tsx`
- `Helmora-Frontend/src/features/chat/ChatPage.tsx`
- `Helmora-Frontend/src/features/chat/ChatPage.css`

**Estimated scope:** M

### Task 2: Immutable registry and versioned runtime configuration

**Description:** Add canonical tool contracts, the immutable TinyFish Search/Fetch registry, safe defaults, configuration normalization, validation, and masked DTO helpers. No connector execution or credential storage is added yet.

**Acceptance criteria:**
- [ ] Unknown tool/connector IDs and attempts to mutate risk/schema/connector identity are rejected.
- [ ] Primary/fallback catalog IDs differ and configuration contains no credential material.
- [ ] Defaults are disabled and normalized limits stay inside the approved Free profile.

**Verification:**
- [ ] RED then GREEN: `npm.cmd test -- src/__tests__/tool-config.test.ts`
- [ ] `npm.cmd run typecheck`

**Dependencies:** None

**Files likely touched:**
- `src/tools/types.ts`
- `src/tools/registry.ts`
- `src/services/tool-config.ts`
- `src/__tests__/tool-config.test.ts`

**Estimated scope:** M

### Task 3: SQLite connector credential vault

**Description:** Introduce encrypted TinyFish credential records and explicit local-store CRUD. The public contract exposes configured/hint metadata only and fails closed when encryption is unavailable.

**Acceptance criteria:**
- [ ] Plaintext never enters settings or database columns; reads decrypt only inside the server credential boundary.
- [ ] Set, rotate, retain-on-omission, and explicit clear semantics are deterministic.
- [ ] DTOs, errors, and diagnostics never contain the secret.

**Verification:**
- [ ] RED then GREEN: focused `connector-vault.test.ts` SQLite cases
- [ ] Existing `control-vault.test.ts` and `storage.test.ts` pass

**Dependencies:** Task 2

**Files likely touched:**
- `src/storage/types.ts`
- `src/storage/sqlite-store.ts`
- `src/storage/control-vault.ts`
- `src/__tests__/connector-vault.test.ts`

**Estimated scope:** M

### Task 4: Supabase and hybrid credential synchronization

**Description:** Extend Supabase and hybrid control-plane/outbox flows for connector credentials without placing secrets in generic settings or outbox diagnostics.

**Acceptance criteria:**
- [ ] Supabase stores encrypted credential material and returns only masked metadata outside the vault.
- [ ] Offline hybrid updates replay in order and converge without plaintext in outbox inspection.
- [ ] Existing provider/API-key reconciliation behavior remains unchanged.

**Verification:**
- [ ] RED then GREEN: focused connector cases in hybrid online/degraded/reconcile tests
- [ ] `npm.cmd test -- src/__tests__/supabase-schema.test.ts`
- [ ] `npm.cmd run typecheck`

**Dependencies:** Task 3

**Files likely touched:**
- `src/storage/supabase-store.ts`
- `src/storage/hybrid-store.ts`
- `src/storage/control-plane.ts`
- `src/lib/supabase-schema.ts`
- `src/__tests__/connector-vault.test.ts`

**Estimated scope:** M

### Task 5: Authenticated Tools admin API

**Description:** Add authenticated GET/config PUT/credential PUT endpoints with atomic non-secret configuration writes, masked secret operations, catalog resolution, warnings, and field-addressable validation.

**Acceptance criteria:**
- [ ] GET returns registered tools, effective overrides, health/warnings, masked credential state, and orchestrator summaries.
- [ ] Configuration PUT cannot mutate server-owned fields; credential PUT never echoes the secret.
- [ ] All endpoints require an admin session and Tools remain disabled by default.

**Verification:**
- [ ] RED then GREEN: `npm.cmd test -- src/__tests__/tools-admin.test.ts`
- [ ] Existing `admin-auth.test.ts` and `spa-routes.test.ts` pass

**Dependencies:** Tasks 2–4

**Files likely touched:**
- `src/routes/tools.ts`
- `src/app.ts`
- `src/services/tool-config.ts`
- `src/__tests__/tools-admin.test.ts`

**Estimated scope:** M

## Checkpoint: Safe Control Plane

- [ ] Playground Markdown is deployable independently.
- [ ] Config contains no credentials and Tools default disabled.
- [ ] SQLite, Supabase, and hybrid credential tests pass.
- [ ] Admin API is authenticated and returns only masked secret metadata.
- [ ] Hub typecheck/build and Frontend lint/build pass.

### Task 6: `/tools` route, API types, and draft helpers

**Description:** Add the direct `/tools` route under System, frontend API types/client methods, and pure helpers for draft normalization, validation, dirty comparison, effective scopes, and warnings.

**Acceptance criteria:**
- [ ] `/tools` is lazy-loaded under System and is included in Cloudflare SPA rewrites.
- [ ] Secret retain/replace/clear is represented separately from the non-secret atomic draft.
- [ ] Pure helpers own validation and derived state rather than component branches.

**Verification:**
- [ ] `npm.cmd run lint`
- [ ] `npm.cmd run build`

**Dependencies:** Task 5

**Files likely touched:**
- `src/types/api.ts`
- `src/lib/api/hub.ts`
- `src/app/router.tsx`
- `src/app/AppShell.tsx`
- `src/features/tools/toolsDraft.ts`

**Estimated scope:** M

### Task 7: `/tools` configuration page and activity shell

**Description:** Build the DESIGN.md-aligned configuration page for runtime status, orchestrator selectors, TinyFish Free profile, masked credential management, immutable registry/scopes, Save/Discard behavior, and an explicit unavailable/empty activity shell. Live connector testing and activity data are wired only after Task 10B.

**Acceptance criteria:**
- [ ] Loading, empty, configured, degraded, dirty, validation, save, and secret-rotation states are understandable in both themes.
- [ ] Registry identity is visibly immutable while enabled/scopes/limits remain configurable.
- [ ] Activity is clearly shown as unavailable/not yet loaded rather than backed by mock production data.
- [ ] Status and warnings do not rely on color alone; controls are keyboard accessible and responsive.

**Verification:**
- [ ] `npm.cmd run lint`
- [ ] `npm.cmd run build`
- [ ] Browser smoke for desktop/mobile and light/dark states

**Dependencies:** Task 6

**Files likely touched:**
- `src/features/tools/ToolsPage.tsx`
- `src/features/tools/ToolsPage.css`
- `src/features/tools/toolsDraft.ts`
- `src/app/AppShell.css`

**Estimated scope:** M

### Task 8: TinyFish Search connector

**Description:** Implement the allowlisted Search request projection, validation, abort/timeout behavior, response normalization, safe sources, and redacted errors behind an injected fetch boundary.

**Acceptance criteria:**
- [ ] Only the official Search endpoint and approved fields are emitted with `X-API-Key` server-side.
- [ ] Conflicting freshness/date filters and oversized input fail before network I/O.
- [ ] Responses normalize into bounded content/sources without leaking upstream bodies or credentials.

**Verification:**
- [ ] RED then GREEN: `npm.cmd test -- src/__tests__/tinyfish-search.test.ts`
- [ ] `npm.cmd run typecheck`

**Dependencies:** Tasks 2–3

**Files likely touched:**
- `src/tools/connectors/tinyfish-client.ts`
- `src/tools/connectors/tinyfish-search.ts`
- `src/tools/validation.ts`
- `src/__tests__/tinyfish-search.test.ts`

**Estimated scope:** M

### Task 9: TinyFish Fetch target validation

**Description:** Implement 1–10 URL Fetch with canonical URL validation, DNS/IP policy, available redirect-metadata revalidation, query redaction, fragment stripping, and bounded Markdown/JSON normalization. TinyFish performs the actual network fetch, so Hub does not claim socket-level DNS pinning.

**Acceptance criteria:**
- [x] Local/private/link-local/metadata targets, alternate IP forms, credentials, non-HTTPS, non-default ports, and unsafe punycode are rejected.
- [x] Hub resolves and inspects every current DNS record before sending the URL, rejecting when any address violates policy.
- [x] Redirect URLs reported by TinyFish are revalidated when metadata is available; TinyFish validation remains defense in depth rather than Helmora's sole boundary.
- [x] Activity never exposes sensitive query strings and signed URLs are marked non-cacheable.

**Verification:**
- [x] RED then GREEN: `npm.cmd test -- src/__tests__/tinyfish-fetch.test.ts`
- [x] `npm.cmd run typecheck`

**Dependencies:** Task 8

**Files likely touched:**
- `src/tools/connectors/tinyfish-fetch.ts`
- `src/tools/url-policy.ts`
- `src/tools/connectors/tinyfish-client.ts`
- `src/__tests__/tinyfish-fetch.test.ts`

**Estimated scope:** M

### Task 10: Bounded limiter, cache, retries, and tool audit

**Description:** Add process-local Search-request and Fetch-URL quota accounting, bounded/versioned caches, retry budgets with `Retry-After`, connector health, and safe tool-run audit persistence.

**Acceptance criteria:**
- [x] Cache hits reserve no quota; uncached Fetch batches reserve atomically or fail without partial execution.
- [x] Retryable statuses stay within attempt/wall-clock budgets; credential/throttle health is observable.
- [x] Audit rows omit arguments, content, raw URLs, headers, and secrets across SQLite/Supabase.

**Verification:**
- [x] RED then GREEN: focused `tool-runtime.test.ts` limiter/cache/retry cases
- [x] RED then GREEN: focused SQLite/Supabase tool-audit tests
- [x] `npm.cmd run typecheck`

**Dependencies:** Tasks 8–9

**Files likely touched:**
- `src/services/tool-executor.ts`
- `src/services/tool-limits.ts`
- `src/storage/types.ts`
- `src/storage/sqlite-store.ts`
- `src/__tests__/tool-runtime.test.ts`

**Estimated scope:** M; Supabase audit persistence may be a separate atomic sub-increment.

### Task 10A: Connector test, health, and activity API

**Description:** Mount the remaining authenticated operational endpoints after the connector executor and audit store exist: one exact TinyFish connectivity test and bounded recent activity reads.

**Acceptance criteria:**
- [ ] `POST /api/tools/connectors/tinyfish/test` requires an admin session, bypasses result cache, and uses one fixed harmless Search query; it never invokes Fetch, Agent, or Browser.
- [ ] The test still passes through timeout, limiter, retry budget, redaction, and audit policy, with audit source `admin_connector_test`.
- [ ] Test responses expose only redacted health/result metadata and create one safe audit record without the credential or raw upstream body.
- [ ] `GET /api/tools/activity` requires an admin session, validates bounded limit/cursor input, and returns allowlisted audit fields only.

**Verification:**
- [ ] RED then GREEN: focused connector-test/activity cases in `tools-admin.test.ts`
- [ ] Credential redaction and admin-auth regression tests pass

**Dependencies:** Tasks 5, 8, and 10

**Files likely touched:**
- `src/routes/tools.ts`
- `src/services/tool-executor.ts`
- `src/storage/types.ts`
- `src/__tests__/tools-admin.test.ts`

**Estimated scope:** M

### Task 10B: Live connector health and activity UI

**Description:** Replace the Task 7 activity shell with real connector-test state and recent safe activity data from Task 10A.

**Acceptance criteria:**
- [ ] Test action shows running/success/throttled/credentials-required/failure states without exposing raw upstream data.
- [ ] Recent activity supports bounded loading and completed/throttled/failed filters.
- [ ] Empty and degraded states remain accessible and do not rely on color alone.

**Verification:**
- [ ] `npm.cmd run lint`
- [ ] `npm.cmd run build`
- [ ] Browser smoke for test and recent-activity states

**Dependencies:** Tasks 7 and 10A

**Files likely touched:**
- `src/lib/api/hub.ts`
- `src/types/api.ts`
- `src/features/tools/ToolsPage.tsx`
- `src/features/tools/ToolsPage.css`

**Estimated scope:** M

## Checkpoint: TinyFish Execution Foundation

- [x] Search/Fetch mapping and URL abuse tests pass without live credentials.
- [x] Limiter/cache/retry behavior is deterministic and bounded.
- [x] Connector health and audit contain no sensitive payloads.
- [ ] `/tools` configures and tests the connector and reads bounded safe activity while runtime execution remains gated.

### Task 11: Request policy and eligible tool projection

**Description:** Implement the exact `X-Helmora-Tools: off|auto|force` wire contract, surface defaults, deterministic bilingual relevance gating, scope projection, CORS preflight support, and explicit rejection of client-supplied OpenAI tools/tool messages.

**Acceptance criteria:**
- [ ] Ordinary `auto` turns skip planning; freshness/research/search/URL intent reaches planning without granting execution authority.
- [ ] Mini/Playground and explicit-route defaults match the spec; `off` always wins.
- [ ] The administrative kill switch is evaluated first: disabled runtime always resolves `off`, including when the header is `force`.
- [ ] Remaining order is valid request override or surface default → tool scope/eligibility → `auto` relevance gate → schema/policy authorization; any other header value returns HTTP 400 `invalid_tools_policy`.
- [ ] `force` bypasses only relevance and cannot enable the runtime, broaden scope, or bypass policy.
- [ ] Approved browser origins can send `X-Helmora-Tools`, and route tests assert the preflight allow-header response.
- [ ] Client-defined tools are rejected as `client_tools_unsupported` rather than forwarded or ignored.

**Verification:**
- [ ] RED then GREEN: `npm.cmd test -- src/__tests__/tool-policy.test.ts`
- [ ] Existing Mini classifier/router tests pass

**Dependencies:** Tasks 2 and 5

**Files likely touched:**
- `src/services/tool-policy.ts`
- `src/tools/types.ts`
- `src/__tests__/tool-policy.test.ts`

**Estimated scope:** S

### Task 12: Canonical bounded tool loop

**Description:** Build the provider-neutral loop state machine for validated calls, deduplication, read-only reauthorization, execution, untrusted result envelopes, truncation, exact budgets, and root cancellation.

**Acceptance criteria:**
- [ ] Every proposed call is schema-validated and policy-checked immediately before execution.
- [ ] Exact boundaries are enforced and tested: 4 rounds, 4 calls/round, 8 calls total, 30,000 ms total, 10,000 ms/connector request, 64 KiB/result, and 128 KiB total tool context or the smaller model budget.
- [ ] One root `AbortSignal` propagates through planning, connector work, retries, native rounds, and answer generation; abort stops new work without unhandled rejection or late activity.
- [ ] Tool results cannot mutate identity, routing, scopes, registry, credentials, or policy.

**Verification:**
- [ ] RED then GREEN: `npm.cmd test -- src/__tests__/tool-loop.test.ts`
- [ ] `npm.cmd run typecheck`

**Dependencies:** Tasks 10–11

**Files likely touched:**
- `src/services/tool-runtime.ts`
- `src/services/tool-loop.ts`
- `src/tools/untrusted-context.ts`
- `src/__tests__/tool-loop.test.ts`

**Estimated scope:** M

### Task 13A: OpenAI Chat and Codex Responses tool translation

**Description:** Extend OpenAI Chat Completions/OpenAI-compatible and the separate Codex Responses adapter to translate registered tools/calls/results while preserving call IDs and keeping protocol shapes inside adapters.

**Acceptance criteria:**
- [ ] OpenAI Chat and OpenAI Responses capability is explicit adapter/catalog metadata, never inferred from a model name.
- [ ] Both protocols round-trip canonical calls/results and reject malformed arguments with protocol-specific fixtures.
- [ ] Codex Responses never receives a Chat Completions tool schema; if a Responses feature cannot be supported, its adapter reports `nativeToolCalling=false` and uses the orchestrator path explicitly.
- [ ] Existing non-tool request and streaming adapter behavior remains unchanged.

**Verification:**
- [ ] RED then GREEN: focused OpenAI/Codex cases in `adapters-p2.test.ts`
- [ ] Existing provider adapter and vision tests pass

**Dependencies:** Task 12

**Files likely touched:**
- `src/services/upstream.ts`
- `src/providers/adapters/codex-responses.ts`
- `src/providers/dispatch.ts`
- `src/__tests__/adapters-p2.test.ts`

**Estimated scope:** M

### Task 13B: Anthropic Messages and Gemini tool translation

**Description:** Translate the same canonical registry/call/result contract for Anthropic Messages and Gemini GenerateContent without leaking either native protocol into routes.

**Acceptance criteria:**
- [ ] Anthropic and Gemini native capability is explicit adapter/catalog metadata.
- [ ] Both adapters preserve canonical call IDs, validate arguments, and serialize normalized tool results correctly.
- [ ] Existing non-tool and streaming behavior remains unchanged.

**Verification:**
- [ ] RED then GREEN: focused Anthropic/Gemini cases in `adapters-p2.test.ts`
- [ ] Existing provider adapter and vision tests pass

**Dependencies:** Task 12

**Files likely touched:**
- `src/providers/adapters/anthropic.ts`
- `src/providers/adapters/gemini.ts`
- `src/providers/dispatch.ts`
- `src/__tests__/adapters-p2.test.ts`

**Estimated scope:** M

### Task 14: Catalog Tool Orchestrator primary/fallback

**Description:** Add strict planner prompting/parsing for non-native answer models, exact catalog primary/fallback resolution, normalized retry behavior, and untrusted result delivery back to the original answer model.

**Acceptance criteria:**
- [ ] Planner emits no call or schema-valid registered read-only calls only; it never authors the final answer.
- [ ] Only configured primary then fallback are attempted and each round emits complete metering lineage for Task 15 to persist.
- [ ] Planner failure never silently claims current information or changes the answer model.

**Verification:**
- [ ] RED then GREEN: `npm.cmd test -- src/__tests__/tool-orchestrator.test.ts`
- [ ] Existing catalog/Mini retry tests pass

**Dependencies:** Tasks 5, 11–12

**Files likely touched:**
- `src/services/tool-orchestrator.ts`
- `src/services/tool-config.ts`
- `src/services/tier-router.ts`
- `src/__tests__/tool-orchestrator.test.ts`

**Estimated scope:** M

### Task 15: Usage lineage and cost attribution

**Description:** Add nullable tool lineage to usage contracts and both storage backends before any multi-round route integration; meter every planner/answer round to the originating request/API-key budget without double counting.

**Acceptance criteria:**
- [ ] Each provider call has a unique usage request ID and root `parentRequestId`/tool run/round lineage.
- [ ] Usage rows include nullable `usagePhase: 'tool_planner' | 'tool_answer_round'` and `toolRound`, so reporting never infers phase from nullable IDs or source strings.
- [ ] API-key budgets include all model rounds exactly once; Admin Playground remains admin-chat usage.
- [ ] SQLite/Supabase schema compatibility and existing reporting remain intact.

**Verification:**
- [ ] RED then GREEN: focused usage, pricing, SQLite, and Supabase schema tests
- [ ] `npm.cmd run typecheck`

**Dependencies:** Task 14

**Files likely touched:**
- `src/keys/types.ts`
- `src/storage/sqlite-store.ts`
- `src/storage/supabase-store.ts`
- `src/lib/supabase-schema.ts`
- `src/__tests__/supabase-schema.test.ts`

**Estimated scope:** M

### Task 16: Runtime integration, cancellation, SSE activity, and CORS diagnostics

**Description:** Integrate native/orchestrated loops after route resolution in `/v1` and admin chat only after usage lineage exists. Add one root cancellation chain, public keepalive comments/headers, and ordered redacted admin `tool_activity` events without exposing native protocol frames.

**Acceptance criteria:**
- [ ] Mini, catalog, mode, and direct answer routing remains unchanged while eligible tools work on every approved surface.
- [ ] Client disconnect/Stop aborts planner, connector, retries, native rounds, and final answer; terminal audit/usage persists once with no late activity or unhandled rejection.
- [ ] Public SSE order is comments → normal OpenAI chunks → `[DONE]`; admin order is metadata → activities → chunks → `[DONE]`.
- [ ] CORS exposes safe tool diagnostics; no secret, raw arguments, or provider tool frame reaches clients.

**Verification:**
- [ ] RED then GREEN: focused `sse.test.ts`, `admin-chat.test.ts`, cancellation, and tool integration cases
- [ ] Explicit non-tool route regression tests pass

**Dependencies:** Tasks 13A, 13B, 14, and 15

**Files likely touched:**
- `src/routes/v1.ts`
- `src/routes/chat.ts`
- `src/lib/runtime-config.ts`
- `src/__tests__/sse.test.ts`
- `src/__tests__/admin-chat.test.ts`

**Estimated scope:** M

### Task 17: Backward-compatible chat activity persistence

**Description:** Version the Hub-backed Playground chat contract additively so redacted tool activities persist with the assistant message/turn they support. The current active store is SQLite/Supabase; legacy localStorage exists only as an import path.

**Acceptance criteria:**
- [ ] `StoredChatMessage` gains bounded `toolActivities?: ChatToolActivity[]` with allowlisted display fields only.
- [ ] SQLite and Supabase add backward-compatible storage; old rows normalize missing activity to `[]` and existing history is never reset.
- [ ] Restoring a persisted `running` activity without a live owning generation converts it to `failed` with `errorCode: 'run_interrupted'`.
- [ ] Legacy browser-history import remains readable and missing activity fields migrate non-destructively.

**Verification:**
- [ ] RED then GREEN: focused `chat-history.test.ts`, SQLite migration, and Supabase schema cases
- [ ] `npm.cmd run typecheck`

**Dependencies:** Task 16

**Files likely touched:**
- `src/storage/chat-types.ts`
- `src/storage/chat-sqlite.ts`
- `src/storage/chat-supabase.ts`
- `src/lib/supabase-schema.ts`
- `src/__tests__/chat-history.test.ts`

**Estimated scope:** M

### Task 18: Playground tool activity presentation

**Description:** Parse the redacted activity stream, associate it with the pending assistant turn, persist it through Task 17, and render lightweight accessible Search/Fetch rows immediately before the supported assistant response.

**Acceptance criteria:**
- [ ] Activity ordering and message association survive streaming, Stop, reload, and Hub-backed session restoration.
- [ ] Interrupted restored activity renders as a terminal failure and never remains on “Searching web…” indefinitely.
- [ ] Rows expose only allowlisted query/redacted URL/source count/duration/error fields; running rows expand, completed rows collapse, and failures remain visible.
- [ ] Collapse controls are keyboard-accessible and work in both themes and reduced motion.

**Verification:**
- [ ] `npm.cmd run lint`
- [ ] `npm.cmd run build`
- [ ] Browser smoke for running/completed/failed Search and Fetch activities plus reload/session restore

**Dependencies:** Tasks 1, 16, and 17

**Files likely touched:**
- `src/lib/chatSse.ts`
- `src/lib/chatRuntime.ts`
- `src/features/chat/ToolActivity.tsx`
- `src/features/chat/ChatPage.tsx`
- `src/features/chat/ChatPage.css`

**Estimated scope:** M

## Checkpoint: Runtime Complete

- [ ] Native and orchestrated Search/Fetch loops work under exact selected answer routing.
- [ ] Public and Admin streaming contracts are proven and CORS headers exposed.
- [ ] Every provider round is metered once with root lineage.
- [ ] Tool activity survives Hub-backed chat persistence and renders accessibly in Playground.
- [ ] Full Hub tests/typecheck/build and Frontend lint/build pass.
- [ ] Security review confirms target-validation, prompt-injection, secret, quota, cancellation, and unbounded-consumption controls.

### Task 19: Final compatibility, browser, and documentation review

**Description:** Run the complete matrix, review combined diffs for scope/secrets, test production-like browser states, and update documentation that contradicts the shipped `/tools` and Playground behavior.

**Acceptance criteria:**
- [ ] All spec success criteria are demonstrated with Tools disabled and enabled.
- [ ] No Agent/Browser, write connector, generic executable connector, DuckDuckGo, scheduler, or webhook implementation slipped into the MVP.
- [ ] Existing Mini and non-tool routes retain compatible behavior and public model identity.

**Verification:**
- [ ] HelmoraHub: `npm.cmd test`, `npm.cmd run typecheck`, `npm.cmd run build`
- [ ] Helmora-Frontend: `npm.cmd run lint`, `npm.cmd run build`
- [ ] Both repositories: `git diff --check`
- [ ] Browser: `/tools`, Markdown, activity, themes, responsive layout, reload/back/forward, network/CORS/SSE
- [ ] Dependency/security review including `npm audit` triage and secret scan

**Dependencies:** Tasks 1–18

**Files likely touched:** Relevant README/docs only where behavior changed.

**Estimated scope:** S

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Connector secret leaks through generic settings/outbox | Critical | Dedicated encrypted methods, masked DTOs, negative tests, no payload logging |
| Unsafe Fetch target reaches internal/sensitive services | Critical | HTTPS/host/IP policy, inspect all current DNS records, validate available redirect metadata, and state TinyFish boundary honestly |
| Provider adapters have incompatible tool protocols | High | Canonical contract and adapter-focused fixtures before route integration |
| Tool loops amplify latency and cost | High | Relevance gate, disabled defaults, hard round/call/time/context bounds, usage lineage |
| Streaming proxies time out during internal rounds | High | Standards-valid SSE keepalive comments with integration tests |
| Hybrid credential changes diverge offline | High | Explicit control-plane entity/outbox tests and ordered convergence |
| Process-local quota exceeds account limit across replicas | Medium | State single-instance limitation; require Redis before multi-replica claims |
| Markdown introduces XSS/tracking/layout abuse | High | No raw HTML/images, safe URL transform, bounded content, React escaping |
| Frontend lacks broad unit test runner | Medium | Keep pure helpers separate; require build/lint plus browser verification |

## Open Questions

None. Deferred work remains write approval/resume, generic connectors, DuckDuckGo production search, MCP, Redis coordination, and proactive automation.
