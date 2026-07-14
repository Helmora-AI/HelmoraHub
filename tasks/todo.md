# Helmora Mini 1.0 Role Router — Task Checklist

## Foundation

- [x] Task 1: Add deterministic bilingual classifier with explicit continuation inputs and tests.
- [ ] Task 2: Add version 2 role config, legacy migration, and slot-wise inheritance.
- [ ] Task 3: Update Admin Mini GET/PUT contract and validation.
- [ ] Checkpoint: focused tests and Hub typecheck pass.

## Runtime

- [ ] Task 4: Add version 2 and projected legacy references to model catalog delete guard.
- [ ] Task 5: Add exact catalog attempts and typed cross-model retry decisions.
- [ ] Task 6: Integrate role routing into non-stream and stream requests.
- [ ] Task 7: Add rebuilt-per-attempt identity, exposed headers, error, and usage observability.
- [ ] Checkpoint: full Hub tests, typecheck, and build pass.

## Admin SPA

- [ ] Task 8: Update frontend API types and make `/agents` Mini-only.
- [ ] Task 9: Build the approved six-card UI with pure draft helpers.

## Completion

- [ ] Task 10: Run full compatibility and quality review.
- [ ] Confirm both repository diffs contain no unrelated or generated files.
- [ ] Confirm all approved spec success criteria.
