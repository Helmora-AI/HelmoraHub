# Helmora Mini 1.0 Role Router Design

**Date:** 2026-07-14
**Status:** Approved for implementation planning
**Surfaces:** HelmoraHub API/runtime and Helmora-Frontend `/agents`

## Summary

Rebuild Helmora Mini 1.0 as an intent-routed multi-model system. The Hub classifies each Mini request into one of six fixed roles, then routes it through a user-selected primary model and one fallback model. Model choices come exclusively from the first-class `/models` catalog.

The Admin SPA will remove Helmora Office from the main Agents surface. `/agents` becomes the direct configuration page for Helmora Mini 1.0. Helmora Office remains an external client and its separate codebase and backend endpoint are not deleted by this change.

## Goals

- Provide six fixed routing roles: `general`, `reasoning`, `coding`, `research`, `creative`, and `review`.
- Let administrators choose one primary and one fallback catalog model for every role.
- Automatically classify Mini prompts without an extra LLM request.
- Route only through explicitly configured catalog models.
- Preserve non-streaming and streaming failover behavior.
- Make role selection and fallback behavior observable.
- Follow `Helmora-Frontend/DESIGN.md` for the Admin SPA.

## Non-goals

- User-defined roles.
- More than one fallback per role.
- LLM-based or embedding-based intent classification.
- Office desk, `role`, or `lane` driven routing.
- Deleting HelmoraOffice or the external Office runtime API.
- A generic workflow builder or visual agent graph.
- Implicit fallback through the existing mode/provider tier chain.

## Fixed Roles

| Role | Purpose | Default when |
|---|---|---|
| `general` | General conversation and uncategorized requests | No specialist role has a positive score |
| `reasoning` | Deep analysis, mathematics, comparison, multi-step reasoning | Reasoning signals win |
| `coding` | Code generation, debugging, refactoring, technical implementation | Coding signals win |
| `research` | Source-oriented research, evidence gathering, synthesis | Research signals win |
| `creative` | Brainstorming, naming, creative writing, ideation | Creative signals win |
| `review` | Critique, audit, validation, quality and security review | Review signals win |

`general` replaces the earlier Office-oriented `coordinator` concept. A standalone `fallback` role is not used because each role owns its own fallback model.

## Configuration Model

The `mini_route_v1` setting keeps its existing storage key and gains a role-based schema.

```ts
type MiniRole =
  | 'general'
  | 'reasoning'
  | 'coding'
  | 'research'
  | 'creative'
  | 'review';

type MiniRoleAssignment = {
  primaryCatalogId: string | null;
  fallbackCatalogId: string | null;
};

type MiniRouteConfig = {
  version: 2;
  enabled: boolean;
  roles: Record<MiniRole, MiniRoleAssignment>;
};
```

The persisted references are catalog IDs, not provider IDs or upstream model IDs. At request time the Hub resolves each catalog ID into its current `providerId` and `modelId`.

### Validation

- A non-null catalog ID must exist.
- The referenced row must be a provider-backed catalog model with a stable catalog ID and a supported adapter/protocol.
- Temporary runtime health does not block saving. Disabled providers, degraded verification, cooldown, OAuth refresh, and short-lived network failures produce warnings instead of validation errors.
- Primary and fallback must differ within the same role.
- Reusing one model across different roles is allowed.
- Partially configured specialist roles inherit missing slots from `general` independently.
- `general` may be saved incomplete, but Mini requests fail clearly until it has a routable primary or fallback.

Static configuration eligibility and current runtime routability are separate concepts:

- **Configurable:** catalog row exists, has `kind=provider`, has a provider/model identity, and uses a supported protocol.
- **Runtime routable:** model and provider are enabled, credentials are usable, adapter is available, and the provider is not prevented from serving the attempt by current health policy.

### Migration

When reading a legacy candidate-based configuration:

1. Resolve the first candidate to a catalog record and assign it to `general.primaryCatalogId`.
2. Resolve the second candidate, when present, to `general.fallbackCatalogId`.
3. Leave specialist roles empty.
4. Preserve the legacy `enabled` value.
5. Persist version 2 only on the next successful configuration write; reads remain non-destructive.

Candidates that cannot be matched to catalog rows are omitted and surfaced as a migration warning in the admin response.

## Intent Classifier

The classifier is a pure synchronous function. It examines classifier-safe user context only. It does not call a provider, database, network, or model.

```ts
classifyMiniIntent({
  latestUserMessage,
  previousUserMessages,
  previousMiniRole,
});
```

The latest user message has full weight. Previous user messages are considered only for explicit continuation turns and use decreasing weight. `previousMiniRole` is optional context when the caller already has session-scoped Mini metadata; it is never required for stateless API correctness.

System messages are excluded from classification. This includes client system prompts, Helmora identity preambles, provider-generated context, compression summaries, and internal routing instructions. They may describe coding, providers, APIs, or models without representing the current user intent.

Each specialist role owns English and Vietnamese weighted signals. Matching normalizes Unicode text to support accented and unaccented Vietnamese while retaining token/phrase boundaries. Examples include:

- `coding`: fenced code, stack traces, file extensions, language/framework names, debug, refactor, implement, sửa code, viết code, lỗi, triển khai, hàm, class, build, compile.
- `research`: research, sources, citations, evidence, literature, nghiên cứu, tìm nguồn, dẫn chứng, trích nguồn, tổng hợp tài liệu, kiểm chứng.
- `reasoning`: prove, calculate, derive, trade-off, step-by-step analysis, phân tích, suy luận, chứng minh, tính toán, đánh đổi, từng bước.
- `creative`: brainstorm, name, slogan, story, ideate, lên ý tưởng, đặt tên, viết truyện, sáng tạo.
- `review`: review, audit, critique, vulnerability, correctness, đánh giá, xem lại, kiểm tra, phản biện, lỗ hổng, đúng chưa.

The classifier returns:

```ts
type MiniClassification = {
  role: MiniRole;
  scores: Record<Exclude<MiniRole, 'general'>, number>;
  matchedSignals: string[];
};
```

The classifier applies `MIN_SPECIALIST_SCORE`; weak or ambiguous single words do not force a specialist role. Tie precedence applies only among roles that meet the threshold:

```text
review > coding > research > reasoning > creative
```

This makes combined prompts such as “review this React code for security bugs” route to `review`, while ordinary implementation prompts route to `coding`.

For a continuation phrase such as “tiếp tục đi”, “sửa luôn phần đó”, “đoạn trên”, or “do that”, the classifier uses the most recent preceding user intent that crosses the threshold. If no prior user intent or trusted previous Mini role is available, it returns `general`. Assistant responses are not scored because long generated code or prose would bias later turns.

## Runtime Resolution

For `model=auto` or `model=helmora-mini-1.0`:

1. Classify the prompt.
2. Load the chosen role assignment.
3. Inherit each missing specialist slot independently from `general`.
4. Resolve the selected catalog records and verify their current routability.
5. Build an ordered attempt list: role primary, then role fallback.
6. Dispatch using the catalog record's exact provider and upstream model.

There is no implicit mode/provider chain after these two attempts.

Slot-wise inheritance is defined as:

```ts
const effectivePrimary = role.primaryCatalogId ?? general.primaryCatalogId;
const effectiveFallback = role.fallbackCatalogId ?? general.fallbackCatalogId;
```

Null entries and duplicate catalog IDs are removed after inheritance, preserving order and a maximum of two attempts.

| Specialist configuration | Effective attempts |
|---|---|
| Both slots empty | General primary → General fallback |
| Primary only | Role primary → General fallback |
| Fallback only | General primary → Role fallback |
| Both slots set | Role primary → Role fallback |

### Failure Behavior

Provider adapters normalize failures before the role router decides whether to advance:

```ts
type MiniAttemptError = {
  code: string;
  retryableAcrossModels: boolean;
  providerHealthEffect: 'none' | 'degraded' | 'invalid_credentials';
};
```

- Network errors, timeouts, `429`, `5xx`, provider credential failures, model-not-found responses, protocol-not-ready, and cooldown states are normally retryable across models.
- Invalid request shape, unsupported parameters, and deterministic client validation failures are not retryable.
- Context-too-long behavior is adapter/policy specific and must be normalized explicitly.
- The role router consumes `retryableAcrossModels`; it does not infer all behavior from broad HTTP status classes.
- Credential failures mark the provider health effect as `invalid_credentials` while still allowing the configured fallback to serve the request.
- A disabled, deleted, or unroutable primary is skipped and the fallback is attempted.
- If both selected models are unavailable, return `mini_role_unavailable`.
- If the chosen role and `general` have no usable assignment, return `mini_role_unconfigured`.
- Disabling Mini returns a clear `mini_disabled` response for Mini model aliases rather than silently using the global mode chain.

Streaming follows the same attempt order. A stream becomes committed only when Helmora sends the first user-visible content delta to the client. Opening upstream headers or receiving internal/reasoning metadata does not commit the stream. A provider that fails before the first visible delta may fall back; after a visible delta is emitted, Helmora must not mix output from another model. The streaming adapter may buffer the first meaningful chunk long enough to validate its shape before committing.

## API Contract

### `GET /api/mini-route`

Returns:

- Product identity (`modelId`, `displayName`).
- Version 2 role configuration.
- Stored and effective catalog summaries for primary and fallback slots, including inheritance source.
- Per-role warnings for missing, disabled, deleted, or unroutable records.
- Classifier metadata: fixed roles and short descriptions.
- Migration warnings when a legacy config could not be mapped completely.

### `PUT /api/mini-route`

Accepts the complete role assignment draft plus `enabled`. The update is atomic. Structurally invalid catalog references return HTTP 400 with a field-addressable validation error. Temporary runtime unavailability returns warnings with a successful save.

The MVP is last-write-wins across multiple admin tabs. The current settings abstraction has no compare-and-set primitive, so optimistic `revision` enforcement is deferred until storage backends can implement it atomically rather than presenting a false concurrency guarantee.

### Model Catalog integration

Deleting a catalog row referenced by any Mini role is rejected with HTTP 409. The operation never auto-clears a Mini slot.

```json
{
  "error": {
    "type": "model_in_use",
    "references": [
      {
        "kind": "helmora_mini_role",
        "role": "coding",
        "slot": "primary"
      }
    ]
  }
}
```

The response lists every Mini role/slot reference. Renaming an upstream `modelId` remains safe because Mini stores the stable catalog ID.

### Runtime observability

Successful Mini responses expose:

- `X-Helmora-Mini-Role`: selected role.
- `X-Helmora-Mini-Slot`: `primary` or `fallback`.
- Existing provider/model routing headers remain intact.

These headers are included in `Access-Control-Expose-Headers` so the cross-origin Admin Playground can read them.

Failure responses include public-safe Mini metadata without exposing secret provider configuration:

```json
{
  "error": {
    "type": "mini_role_unavailable",
    "message": "No configured model is currently available for the coding role.",
    "mini": {
      "role": "coding",
      "attemptedSlots": ["primary", "fallback"],
      "requestId": "req_..."
    }
  }
}
```

Usage records continue to store the actual upstream provider and model and gain nullable `miniRole`, `miniSlot`, and `miniCatalogId` dimensions. Attempt metadata includes role, slot, catalog ID, normalized error code, and health effect for server-side diagnostics. Public `/v1` responses retain the Helmora Mini identity; detailed upstream diagnostics remain available to server logs and authenticated admin surfaces.

## Identity Context Coordination

Helmora Mini keeps two distinct layers:

- **Public product identity:** `Helmora Mini 1.0`.
- **Operational execution:** selected role, catalog ID, provider, upstream model, and primary/fallback slot.

The runtime pipeline is ordered as follows:

```text
Validate client messages
→ extract classifier-safe user context
→ classify Mini role
→ resolve role models
→ compress conversation when applicable
→ inject Helmora Mini identity
→ dispatch selected attempt
```

Identity, provider context, compression metadata, and internal routing instructions never feed back into classification. Each fallback attempt receives exactly one correctly resolved identity message; the pipeline must not append an additional identity message on retry. The public response model is canonicalized to `helmora-mini-1.0`, while the originally requested alias remains internal request metadata for diagnostics.

## Security Boundary

The intent classifier answers only “which configured model should handle this request?” It does not grant tools, filesystem access, network access, credentials, or any other capability. Future role-specific tools must remain behind independent policy and user-approval boundaries; keyword classification is never authorization.

## Admin SPA

### Information Architecture

- `/agents` renders Helmora Mini 1.0 directly.
- `/agents/mini` redirects to `/agents` for compatibility.
- `/agents/office` is removed from the Admin SPA router.
- The Office tab, Office copy, and Office lazy import are removed from the main Agents surface.
- The HelmoraOffice project and Hub's external Office endpoint remain unchanged.

### Page Structure

1. Page header with `Helmora Mini 1.0` and “Intent-routed multi-model system”.
2. Active/inactive status chip and configured-role summary.
3. Six role cards in a responsive `3 → 2 → 1` grid.
4. Draft action row containing `Save configuration` and `Discard changes`.
5. Inline loading, save, validation, and stale-catalog feedback.

Each role card contains:

- Role name and one-line purpose.
- A semantic accent edge or field.
- Searchable Primary model selector.
- Searchable Fallback model selector.
- Stored and effective Primary/Fallback routing, including “Inherited from General” when applicable.
- Provider label, upstream model ID, and current availability status.
- Inline warning when a stored selection is no longer valid.
- A non-blocking warning when primary and fallback use the same provider, because a provider-wide outage may affect both.

All statically configurable provider models from `/models` appear as selector choices. Current runtime health is represented with status chips such as Ready, Degraded, Disabled, or Credentials required. Temporarily unavailable and existing stale selections remain visible so administrators can configure or repair them instead of losing the selected value.

### Visual Language

`Helmora-Frontend/DESIGN.md` is authoritative:

- Space Grotesk for page, section, and role headings.
- IBM Plex Sans for copy and controls.
- IBM Plex Mono for catalog/model metadata.
- Astryx `Selector`, `Button`, `Banner`, `Skeleton`, and status primitives.
- Tinted surfaces, hairline borders, 12px card radius, and restrained shadows.
- No purple-glow treatment, glassmorphism, nested cards, or decorative animation.
- Support light and dark themes together.
- Use existing semantic tokens: teal for general, violet for reasoning, blue for coding, cyan for research, amber for creative, and restrained magenta for review.
- Honor reduced motion; only a subtle dirty-state/action transition is permitted.

The selected layout is the role-card option from the Visual Companion review, not a settings matrix.

### Draft Behavior

- Query results initialize a local draft.
- Changing selectors does not issue API requests immediately.
- Save sends the complete version 2 configuration once.
- Discard restores the last server-confirmed configuration.
- Save is disabled when the draft is unchanged or locally invalid.
- When the draft is dirty, the action row becomes sticky at the bottom of the viewport so all six cards remain practical on smaller screens.
- Navigation with unsaved changes uses the existing browser confirmation mechanism only if one already exists; adding a global navigation blocker is outside this slice.

A “Test classification” control is explicitly deferred to a follow-up slice.

## Testing Strategy

### Hub unit tests

- Every classifier role and the `general` default.
- English, accented Vietnamese, and unaccented Vietnamese signals.
- Minimum specialist threshold, weighted matches, and deterministic tie precedence.
- Continuation turns using previous user intent or trusted previous Mini role.
- System, identity, compression, and internal routing text cannot influence classification.
- Empty, malformed, and non-string message content.
- Version 2 normalization and legacy migration.
- Duplicate primary/fallback rejection.
- Slot-wise specialist inheritance from `general`, including duplicate removal.
- Normalized retry decisions and provider health effects.

### Hub integration tests

- GET returns resolved role assignments and warnings.
- PUT rejects structurally invalid catalog IDs but accepts temporarily degraded selections with warnings.
- Catalog delete returns all Mini role/slot references with `model_in_use`.
- Primary succeeds without fallback.
- Retryable credential, model-not-found, timeout, throttling, and server failures advance to fallback.
- Invalid request and unsupported-parameter failures do not advance.
- Unavailable role inherits `general`.
- Missing general assignment returns `mini_role_unconfigured`.
- Streaming may fall back before the first visible delta and never after it.
- Non-stream and stream routes expose role/slot headers through CORS.
- Usage persists Mini role, slot, and catalog ID.
- Identity is injected once per attempt and excluded from classification.
- Legacy clients using `model=auto` receive canonical Mini behavior.

### Frontend verification

- Production TypeScript/Vite build.
- Oxlint with no new warnings.
- Browser verification for loading, error, clean, dirty, save, and stale-model states.
- Desktop three-column, tablet two-column, and mobile one-column layouts.
- Light and dark theme contrast.
- Keyboard access and visible labels for both selectors in every role card.

No frontend test dependency is added in this slice. Runtime-critical behavior is covered in Hub tests; the frontend is verified through build, lint, and browser checks.

## Compatibility and Rollout

- `helmora-mini-1.0` is the canonical public product ID.
- `auto` is a compatibility alias for Helmora Mini and follows the same six-role router. It does not use the global provider/mode chain.
- Response model identity is canonicalized to `helmora-mini-1.0`; the requested alias is retained only as internal diagnostic metadata.
- Add an explicit integration test for legacy clients that send `model=auto`.
- Keep the storage key `mini_route_v1` to avoid orphaning existing settings.
- Read legacy configuration throughout the rollout.
- Preserve existing catalog/model selection behavior outside Mini.
- Preserve explicit `catalog/<catalogId>` and `mode/<mode>` requests.
- Office-specific routing branches are not expanded or used by Mini; removing those backend branches is a separate cleanup task.

## Success Criteria

- An administrator can configure Primary and Fallback for all six roles using only catalog choices.
- A Mini request is classified deterministically and routed to the matching role's primary model.
- Retryable primary failure uses exactly the configured role fallback.
- Continuation turns preserve the previous user intent without scoring assistant or identity text.
- Temporary provider degradation does not prevent administrators from saving a valid catalog assignment.
- Catalog rows referenced by Mini cannot be deleted until the admin changes the Mini assignment.
- The Hub never silently escapes to an unconfigured provider chain.
- The public model remains Helmora Mini while operational provider/model details stay in controlled diagnostics.
- `/agents` contains no Office UI and matches the existing Helmora design system in both themes.
- Existing non-Mini model routes continue to work.
