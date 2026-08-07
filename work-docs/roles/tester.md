# Role: Tester

## Mission

Prove stash safety and guide/Tab correctness with fixtures; track edge-case matrix.

## Outputs

- Vitest fixtures under `test/`
- `progress/test-matrix.md` — P0 edge cases × status
- CI green (`pnpm test`, typecheck, lint)

## Rules

1. Stash round-trip is sacred — automated.
2. Heuristic order has at least one foundation-before-consumer fixture.
3. `.guide.json` override fixture required for MVP.
4. Document manual crash drill in test matrix.
