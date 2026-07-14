# Helmora Tools Runtime Checklist

## Safe presentation

- [ ] Task 1: Safe assistant Markdown in Playground (implemented; browser smoke pending)

## Control plane

- [x] Task 2: Immutable registry and versioned runtime configuration
- [x] Task 3: SQLite connector credential vault
- [x] Task 4: Supabase and hybrid credential synchronization
- [x] Task 5: Authenticated Tools admin API
- [x] Checkpoint: Safe Control Plane

## Admin UI and connectors

- [x] Task 6: `/tools` route, API types, and draft helpers
- [ ] Task 7: `/tools` configuration page and activity shell (implemented; browser smoke pending)
- [x] Task 8: TinyFish Search connector
- [ ] Task 9: TinyFish Fetch target validation
- [ ] Task 10: Bounded limiter, cache, retries, and tool audit
- [ ] Task 10A: Connector test, health, and activity API
- [ ] Task 10B: Live connector health and activity UI
- [ ] Checkpoint: TinyFish Execution Foundation

## Runtime

- [ ] Task 11: Request policy and eligible tool projection
- [ ] Task 12: Canonical bounded tool loop
- [ ] Task 13A: OpenAI Chat and Codex Responses tool translation
- [ ] Task 13B: Anthropic Messages and Gemini tool translation
- [ ] Task 14: Catalog Tool Orchestrator primary/fallback
- [ ] Task 15: Usage lineage and cost attribution
- [ ] Task 16: Runtime integration, cancellation, SSE activity, and CORS diagnostics
- [ ] Task 17: Backward-compatible chat activity persistence
- [ ] Task 18: Playground tool activity presentation
- [ ] Checkpoint: Runtime Complete

## Final review

- [ ] Task 19: Final compatibility, browser, and documentation review
