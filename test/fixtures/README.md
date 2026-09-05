# Test fixtures

## Diffs (`diffs/`)

Unified diffs consumed by the pure guide layer (parse → groups → heuristic → merge).

| File | Role |
|------|------|
| `foundation-order.diff` | Multi-file foundation-before-consumer ordering |
| `helper-consumer-refactor.diff` | **P0-G2 golden** — same-file helper + consumer; must not be one Tab |
| `intra-hunk-groups.diff` | Intra-hunk line-group boundaries |
| `awkward.diff` | Parser edge cases (removals, renames, etc.) |
| `quoted-and-nonewline.diff` | Quoted paths / `\ No newline at end of file` |

## Guides (`guides/`)

`.guide.json` v1 documents. Prefer pairing a pedagogy fixture with its named diff.

| File | Role |
|------|------|
| `helper-consumer.guide.json` | **Correct** split for `helper-consumer-refactor.diff` (`event-action-name` → `jsx-event-adopts`) |
| `helper-consumer-merged.guide.json` | **Wrong** whole-file merge of those two thoughts (negative / dogfood reject sample) |
| `valid.guide.json` / `replace.guide.json` | General merge + strategy fixtures for `foundation-order.diff` |
| `invalid.guide.json` / `unsupported-version.guide.json` / `forward-compatible.guide.json` | Schema / loader edge cases |

### P0-G3 dogfood

1. Open `diffs/helper-consumer-refactor.diff` (or apply it in a throwaway tree).
2. Ask an agent for a `.guide.json` **without** showing `helper-consumer.guide.json`.
3. Pass only if the agent emits **≥2 steps** that separate the helper from the consumer (ranges + order), not a single whole-file claim like `helper-consumer-merged.guide.json`.
4. Compare against `helper-consumer.guide.json` for expected ids / order.

Authoring prose: `work-docs/guides/agent-guide-authoring.md` §5.1.
