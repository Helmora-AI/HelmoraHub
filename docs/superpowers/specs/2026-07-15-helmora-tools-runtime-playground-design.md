# Helmora Tools Runtime and Playground Design

**Date:** 2026-07-15
**Status:** Approved design, pending implementation planning
**Surfaces:** HelmoraHub runtime/admin API and Helmora-Frontend `/tools` and Playground

## Objective

Add a shared tool runtime to HelmoraHub so every model route can use administrator-approved external tools. The first production connector is TinyFish Search + Fetch under its free plan. Models with native tool calling use their provider protocol; models without native tool calling use a user-selected Tool Orchestrator model and fallback from the `/models` catalog.

Improve the Admin Playground at the same time:

- Render assistant Markdown instead of showing raw markers such as `**bold**`.
- Show tool calls as observable, collapsible activity rows similar to `Search web` and `Read URL` traces.
- Automatically execute read-only tools.
- Require explicit confirmation before any tool with external side effects.

The design prepares a stable connector boundary for future HTTP APIs, real-time context services, MCP servers, and webhooks without turning this slice into a workflow scheduler.

## Approved Product Decisions

- `/tools` is a first-class page in the Admin SPA's **System** category.
- Tool availability applies to Mini aliases, `catalog/*`, `mode/*`, and directly selected Hub models.
- Native tool calling is preferred when the selected model and provider adapter support it.
- A catalog-selected Tool Orchestrator primary and fallback provide tool planning for models without native tool calling.
- Read-only tools may run automatically. Side-effecting tools require confirmation.
- The connector strategy is hybrid: curated first-party presets plus a normalized generic connector boundary.
- TinyFish Search and Fetch are the only TinyFish APIs enabled in this slice. Agent and Browser are excluded.
- DuckDuckGo remains experimental and is not a production preset until a stable official general-search API is available.
- Proactive scheduled jobs and inbound event automation are deferred. The registry and audit model must not prevent them later.

## Source-Verified Constraints

TinyFish currently documents Search and Fetch as free and as consuming zero credits. The current Free-tier reference limits are:

- Search: `30` requests per minute per API key.
- Fetch: `150` URLs per minute per API key, with at most `10` URLs in one request.

Helmora uses conservative local defaults of `25` Search requests per minute and `120` fetched URLs per minute. Provider pricing and limits are external policy, not permanent application invariants. The UI describes the active profile as `TinyFish Search + Fetch Free`, and the runtime still handles provider `429` responses.

Official references:

- TinyFish Search: <https://docs.tinyfish.ai/search-api/reference>
- TinyFish Fetch: <https://docs.tinyfish.ai/fetch-api/reference>
- TinyFish pricing: <https://www.tinyfish.ai/pricing>
- OpenAI function calling: <https://developers.openai.com/api/docs/guides/function-calling>
- Claude tool use: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools>
- Gemini function calling: <https://ai.google.dev/gemini-api/docs/function-calling>
- MCP tools and human-in-the-loop guidance: <https://modelcontextprotocol.io/specification/2025-06-18/server/tools>
- Safe React Markdown rendering: <https://github.com/remarkjs/react-markdown>

## Non-goals

- TinyFish Agent API, Browser API, browser sessions, or paid credits.
- Relying on undocumented DuckDuckGo result endpoints or scraping DuckDuckGo HTML.
- A workflow builder, cron scheduler, event bus, or proactive automation engine.
- Letting a keyword classifier grant tools, credentials, filesystem access, or network authority.
- Executing arbitrary JavaScript or shell code supplied by a model.
- Allowing models to invent HTTP endpoints, headers, or credentials outside configured schemas.
- Replacing the existing Mini role router or global model routing behavior.
- Adding raw HTML, remote images, or executable content to Playground Markdown.

## Architecture

```text
Client request
    -> existing model route resolution
    -> eligible tool projection
    -> native tool adapter OR Tool Orchestrator
    -> schema validation and policy decision
    -> connector execution
    -> normalized tool result and public activity event
    -> selected answer model
    -> canonical client response
```

The Tool Runtime sits after route resolution and before the final answer. It never appends an unrelated provider chain or changes the model chosen by Mini, catalog, mode, or direct routing.

### Canonical contracts

```ts
type ToolRisk = 'read' | 'write';
type ToolSurface = 'mini' | 'catalog' | 'mode' | 'direct';

type ToolDefinition = {
  id: string;
  name: string;
  title: string;
  description: string;
  connector: 'tinyfish_search' | 'tinyfish_fetch' | 'http' | 'webhook';
  enabled: boolean;
  risk: ToolRisk;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  scopes: Record<ToolSurface, boolean>;
};

type ToolCall = {
  id: string;
  requestId: string;
  toolId: string;
  arguments: Record<string, unknown>;
  risk: ToolRisk;
  status: 'proposed' | 'approval_required' | 'running' | 'completed' | 'failed' | 'rejected';
};

type ToolSource = {
  title: string | null;
  url: string;
  snippet: string | null;
};

type ToolResult = {
  callId: string;
  isError: boolean;
  content: string;
  structuredContent?: Record<string, unknown>;
  sources: ToolSource[];
  truncated: boolean;
};
```

Tool definitions use JSON Schema-compatible input and output shapes so provider adapters, the generic connector boundary, and a future MCP client can share one internal representation. External tool annotations are treated as untrusted until an administrator approves the connector.

## Configuration Model

The MVP stores one versioned document through the existing settings abstraction:

```ts
type ToolRuntimeConfig = {
  version: 1;
  enabled: boolean;
  orchestrator: {
    primaryCatalogId: string | null;
    fallbackCatalogId: string | null;
  };
  tinyfish: {
    enabled: boolean;
    apiKey: string | null;
    searchRequestsPerMinute: number;
    fetchUrlsPerMinute: number;
    searchCacheSeconds: number;
    fetchCacheSeconds: number;
  };
  tools: ToolDefinition[];
};
```

The setting key is `tool_runtime_v1`. GET responses replace a stored API key with secret metadata such as `configured: true` and a short masked suffix. PUT treats an omitted secret as “keep the current value” and an explicit clear operation as removal. Secrets never appear in logs, activity payloads, model context, validation errors, or browser-readable query cache.

The Tool Orchestrator references stable catalog IDs. Primary and fallback must differ, must reference provider-backed catalog models, and may be temporarily unhealthy when saved. Current health creates warnings rather than destroying valid configuration.

## Built-in TinyFish Tools

### `web_search`

Accepted fields are a constrained projection of the official Search API:

```ts
type WebSearchInput = {
  query: string;
  location?: string;
  language?: string;
  page?: number;
  recencyMinutes?: number;
  afterDate?: string;
  beforeDate?: string;
  domainType?: 'web' | 'news' | 'research_paper';
  purpose?: string;
};
```

The connector maps camel-case fields to TinyFish query parameters and rejects mutually exclusive freshness options before making a network request. Results normalize to ranked `ToolSource` entries plus structured metadata.

### `web_fetch`

```ts
type WebFetchInput = {
  urls: string[];
  format?: 'markdown' | 'json';
};
```

The connector permits 1–10 HTTPS URLs. HTML output is deliberately excluded from the model-facing preset. Hub validation rejects URL credentials, localhost, loopback, link-local, private-network literals, and disallowed schemes before contacting TinyFish. Redirect and content safety remain defense-in-depth responsibilities even though TinyFish also validates targets.

TinyFish Search and Fetch share one `X-API-Key`, but no other TinyFish endpoint is present in the connector allowlist.

## Rate Limiting, Caching, and Failure Policy

The initial limiter and cache are bounded and process-local, matching the current single-instance Pterodactyl deployment. A future multi-replica rollout must coordinate them through Redis before claiming account-wide enforcement.

- Search default: 25 requests/minute; configurable range 1–30.
- Fetch default: 120 URLs/minute; configurable range 1–150.
- Search cache default: 60 seconds, keyed by normalized full input.
- Fetch cache default: 300 seconds, keyed per URL and output format.
- Cache entries are bounded by count and result size; secrets never participate in browser-visible keys.
- `429`, `500`, and `503` retry with exponential backoff and jitter within a small attempt/time budget.
- `400`, `401`, `402`, `403`, and `404` do not retry blindly.
- `401/403` mark the connector as credentials/access required.
- `429` records throttled health and the most recent occurrence.
- A tool failure is returned to the model as a structured error. The model may explain the failure but must not fabricate fresh information.

## Model Tool-Calling Paths

### Native-capable models

Provider adapters translate canonical tool definitions into their native function/tool schema, preserve call IDs, validate returned arguments, execute through the Tool Runtime, and send normalized results back to the same selected model. The loop supports zero or more calls but enforces limits on rounds, parallel calls, wall-clock time, and result size.

Tool capability is explicit adapter/catalog metadata with an administrator override; it is not guessed solely from a model name.

### Models without native tool calling

The Tool Orchestrator receives the user request and eligible read-only tool definitions. It returns a strict planning result: no tool call or one/more schema-valid calls. The orchestrator does not author the final answer. Tool results are passed to the originally selected answer model as clearly delimited, untrusted context.

The configured orchestrator primary is tried first and its configured fallback is used only for retryable failure or current unroutability. There is no implicit provider chain. If both are unavailable when planning is required, Hub returns `tool_orchestrator_unavailable` rather than pretending the answer is current.

### Loop bounds

- Maximum tool rounds per user request: 4.
- Maximum calls per round: 4.
- Maximum total calls per request: 8.
- Maximum normalized result size and model-context contribution are bounded and observable.
- Repeated identical calls in one request are deduplicated unless the tool definition explicitly allows repetition.

## Policy and Approval

Read-only tools such as Search, Fetch, and read-only context APIs may execute automatically when enabled and in scope.

Tools marked `write` enter `approval_required` before execution. The approval record contains a redacted description, tool ID, public arguments, requesting model, expiry, and request ID. Approval authorizes exactly that immutable call payload; changing arguments creates a new approval.

The Admin Playground can approve or reject a pending call. Standard `/v1` clients do not have a Helmora approval UI, so write tools never auto-run there in the MVP. They return a public-safe `tool_approval_required` error with a request ID. A future delegated approval token may extend this without weakening the default.

Tool risk, connector allowlists, domain policy, and user approval are runtime authorization boundaries. Model output and keyword classification are never authorization.

## Web-Content Security Boundary

Search snippets and fetched pages are untrusted data and may contain prompt injection. The runtime:

- labels tool content as untrusted evidence rather than instructions;
- keeps system, identity, routing, credential, and approval policy outside tool results;
- never exposes secrets or internal headers to the model;
- truncates and normalizes content before model insertion;
- preserves source URLs separately for citation/activity UI;
- prevents fetched text from enabling another tool, broadening scope, or approving a write action;
- records the connector and source used for diagnostics.

## Admin API

### `GET /api/tools`

Returns product status, masked configuration, resolved orchestrator catalog summaries, built-in and configured tool definitions, connector health, effective limits, warnings, and a bounded recent-activity summary.

### `PUT /api/tools/config`

Accepts the complete version 1 draft and applies it as one logical update. It validates catalog references, duplicate IDs, schemas, connector/risk combinations, scopes, limits, and secret operations. Temporary connector or provider health produces warnings with a successful save.

### `POST /api/tools/connectors/:id/test`

Runs a small administrator-initiated connectivity test. TinyFish testing uses a bounded Search request and never invokes Agent or Browser. The response is redacted and creates an audit entry.

### Approval and activity

```text
GET  /api/tools/activity
POST /api/tools/approvals/:id/approve
POST /api/tools/approvals/:id/reject
```

Approval endpoints require admin authentication, reject expired or already-resolved calls, and are idempotent for the same final decision.

## Public Runtime Compatibility

Existing OpenAI-compatible `/v1` response shapes remain valid. Internal tool calls do not leak provider secrets or replace the canonical response model identity.

- Non-streaming clients receive the final assistant response after read-only tool execution.
- Streaming clients receive ordinary assistant content deltas only after internal tool rounds complete; Hub never mix-streams raw provider tool protocol.
- Public responses may expose safe diagnostic headers such as `X-Helmora-Tools-Used` and `X-Helmora-Tool-Run-Id`; these are also listed in `Access-Control-Expose-Headers`.
- Admin Playground uses its authenticated chat stream to receive richer `tool_activity` events without extending the public OpenAI event contract.

## Playground Activity Contract

```ts
type ToolActivityEvent = {
  id: string;
  requestId: string;
  phase: 'proposed' | 'approval_required' | 'running' | 'completed' | 'failed' | 'rejected';
  kind: 'search' | 'fetch' | 'api' | 'webhook';
  label: string;
  query?: string;
  urls?: string[];
  sourceCount?: number;
  durationMs?: number;
  errorCode?: string;
};
```

Events contain only allowlisted display fields. A Search row displays the query and resulting source count. A Fetch row displays the safe URL. Running rows start expanded; completed rows collapse automatically but remain keyboard-accessible. Failed and approval-required states remain expanded until acknowledged.

The activity sits directly before the assistant response it supported. It is a lightweight trace, not a nested card dashboard. Source links use safe external-link behavior and visible host labels.

## Playground Markdown

Assistant content is rendered with `react-markdown` and `remark-gfm`, using custom components styled by the existing Helmora design tokens.

- Support paragraphs, emphasis, strong text, headings, lists, blockquotes, links, tables, inline code, and fenced code.
- Do not enable raw HTML parsing.
- Disable remote Markdown images in this slice to avoid tracking and layout abuse.
- Allow only safe `http`, `https`, and `mailto` links; external links use `target="_blank"` and `rel="noopener noreferrer"`.
- User-authored chat bubbles stay plain text.
- Streaming partial Markdown must remain readable and settle into the final structure without replacing the message identity.
- Code blocks scroll horizontally and preserve copyable plain text.

## `/tools` Admin SPA

The route is added under the **System** navigation category. It follows `Helmora-Frontend/DESIGN.md`, supports both themes, and uses Astryx controls.

Page structure:

1. Header: `Tools` and “External context and action runtime”.
2. Runtime status and enabled-tool summary.
3. Tool Orchestrator primary/fallback catalog selectors.
4. TinyFish Search + Fetch connector panel with masked key, test action, Free profile, current health, effective limits, and cache controls.
5. Tool registry showing risk, scopes, status, and connector type.
6. Read/write policy explanation and approval status.
7. Recent activity with filters for completed, throttled, failed, and approval-required calls.
8. Atomic Save/Discard draft actions.

The visual language uses tinted surfaces, hairline borders, 12px radii, restrained shadows, Space Grotesk headings, IBM Plex Sans controls, and IBM Plex Mono IDs/limits. Status never relies on color alone. The page avoids glow, glassmorphism, decorative animation, and nested-card overload.

## Storage and Observability

Configuration uses `tool_runtime_v1`. Tool-run audit data gains a storage abstraction usable by SQLite and Supabase:

```ts
type ToolRunRecord = {
  id: string;
  requestId: string;
  toolId: string;
  connector: string;
  surface: ToolSurface;
  answerCatalogId: string | null;
  plannerCatalogId: string | null;
  risk: ToolRisk;
  status: ToolCall['status'];
  durationMs: number | null;
  sourceCount: number | null;
  errorCode: string | null;
  createdAt: string;
};
```

Arguments, fetched content, API keys, authorization headers, and full tool outputs are not stored in the default audit row. Server logs use IDs and normalized error codes. Metrics cover call count, success/failure/throttle rate, cache hits, latency, approval decisions, connector, tool, and surface.

## Errors

Public-safe error types include:

- `tools_disabled`
- `tool_unavailable`
- `tool_invalid_arguments`
- `tool_rate_limited`
- `tool_orchestrator_unconfigured`
- `tool_orchestrator_unavailable`
- `tool_approval_required`
- `tool_execution_failed`

Responses include a request ID and tool ID where safe, never connector credentials or raw upstream payloads.

## Testing Strategy

### Hub unit tests

- Configuration normalization, masking, secret retain/clear semantics, and validation.
- TinyFish Search/Fetch request mapping and response normalization.
- Search freshness/date validation and Fetch URL security validation.
- Rate-limit accounting by request versus URL, bounded cache behavior, retry taxonomy, and backoff budget.
- Read/write policy, immutable approval payloads, expiry, and idempotent decisions.
- Native capability selection, orchestrator primary/fallback, loop limits, call deduplication, and result truncation.
- Tool content cannot mutate system, identity, routing, scope, or approval state.

### Hub integration tests

- GET masks secrets and resolves catalog summaries.
- PUT rejects invalid schema/catalog/risk/scope data but accepts temporarily unhealthy selections with warnings.
- Connector test calls only approved TinyFish Search/Fetch hosts.
- Mini, catalog, mode, and direct routes receive the same eligible tool projection.
- Native and orchestrated models can complete read-only tool loops.
- Public `/v1` write calls stop at approval required.
- Admin chat emits ordered, redacted tool activity events.
- Streaming emits no raw provider tool protocol and preserves final model identity.
- Headers are exposed through CORS.
- SQLite and Supabase store safe audit dimensions without arguments or content.

### Frontend verification

- Production TypeScript/Vite build.
- Oxlint with no new warnings.
- Browser verification of `/tools` loading, empty, configured, degraded, dirty, save, validation, and activity states.
- Playground Markdown for bold/italic, lists, links, tables, inline/fenced code, malformed/incomplete Markdown, and attempted raw HTML.
- Tool activities for running, completed/collapsed, failed, and approval-required states.
- Keyboard interaction, visible focus, reduced motion, desktop/mobile layouts, and light/dark contrast.

No new broad frontend test framework is required in this slice. Pure config/draft/activity helpers should be separated from React components for later unit coverage.

## Commands

HelmoraHub:

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

Helmora-Frontend:

```powershell
npm.cmd run lint
npm.cmd run build
```

Both repositories:

```powershell
git diff --check
```

## Project Structure

Likely Hub boundaries:

```text
src/services/tool-runtime*        canonical orchestration and policy
src/tools/connectors/*            TinyFish and future connector adapters
src/providers/*                   native provider tool translation
src/routes/tools.ts               authenticated admin API
src/routes/v1.ts                  public runtime integration
src/routes/chat.ts                Playground activity integration
src/storage/*                     safe tool-run audit storage
src/__tests__/*                   unit and integration coverage
```

Likely Frontend boundaries:

```text
src/features/tools/*              /tools page, draft helpers, activity views
src/features/chat/*               Markdown and inline tool activity
src/lib/api/*                     admin API and chat event client
src/types/api.ts                  shared response/event types
src/app/router.tsx                /tools route
src/app/AppShell.tsx|.css         System navigation and visual composition
```

## Code Style

Prefer narrow, explicit discriminated contracts over connector conditionals spread through routes:

```ts
switch (decision.kind) {
  case 'execute':
    return executeApprovedTool(decision.call);
  case 'approval_required':
    return createPendingApproval(decision.call);
  case 'deny':
    return toolPolicyError(decision.reason);
}
```

Provider-specific request/response translation remains inside adapters. Routes coordinate services and serialize contracts; they do not implement connector policy inline.

## Boundaries

### Always

- Validate model-generated arguments against the configured schema.
- Recheck tool enablement, scope, risk, and approval immediately before execution.
- Redact secrets and untrusted upstream payloads from public errors and logs.
- Bound rounds, calls, time, content size, cache size, and retries.
- Begin behavioral backend slices with failing tests.
- Preserve explicit non-tool model routing and OpenAI-compatible response shapes.

### Ask first

- Enable a paid TinyFish API or raise a connector beyond the documented Free limits.
- Add a new executable connector type, inbound webhook receiver, or scheduler.
- Permit a write tool to auto-run on any surface.
- Add raw HTML/images to Markdown or persistent storage of fetched content/tool arguments.
- Change the public `/v1` event schema or require clients to understand Helmora-specific events.

### Never

- Commit API keys or return them from the Admin API.
- Execute model-supplied code, arbitrary URLs, headers, or credentials outside approved definitions.
- Treat web content or tool metadata as trusted system instructions.
- Let tool use silently switch the selected answer model or escape to an unconfigured provider chain.
- Invoke TinyFish Agent or Browser under the Search + Fetch Free connector.

## Rollout

1. Ship safe Playground Markdown independently.
2. Add versioned Tool configuration and `/tools` management without runtime execution.
3. Add TinyFish Search/Fetch connectors, policy, limiter/cache, and audit.
4. Integrate native provider tool loops, then the non-native Tool Orchestrator path.
5. Add Admin Playground activity events and read-only automatic execution.
6. Add write-tool approval plumbing without enabling proactive jobs.
7. Verify all existing Mini and non-Mini model routes remain compatible.

Tools default disabled after upgrade. Saving a valid connector and enabling the runtime is an explicit administrator action.

## Success Criteria

- Playground renders safe assistant Markdown and no longer displays ordinary Markdown markers as raw text.
- Search and Fetch activity is visible, redacted, keyboard-accessible, and collapses after completion.
- An administrator can configure and test TinyFish Search + Fetch without exposing the API key.
- Runtime enforcement stays within configured Free-profile limits and handles throttling without unbounded retries.
- Mini, catalog, mode, and direct model routes can use the same enabled read-only tools.
- Native-capable models use provider tool calls; non-native models use the configured orchestrator while preserving the selected answer model.
- Write tools never execute without an immutable explicit approval.
- Web content cannot grant capabilities, alter routing/identity, reveal credentials, or approve actions.
- Public `/v1` compatibility and existing non-tool routes remain intact.
- `/tools` matches the existing Helmora design language in light and dark themes.

## Deferred Follow-ups

- Production DuckDuckGo connector when an official stable general-search API exists.
- MCP client/server connector management.
- Proactive event webhooks, schedules, durable automation jobs, and retries across restarts.
- Redis-coordinated account-wide rate limiting and cache for multi-replica deployments.
- Delegated approval tokens for trusted non-Admin clients.
- Capability-aware tool selection based on measured model quality and cost.

## Open Questions

None for implementation planning.
