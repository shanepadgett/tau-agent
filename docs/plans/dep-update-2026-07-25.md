# Dependency update 2026-07-25

Exact pins only. Skip workspace `@shanepadgett/*` and `*` peers.
No bumps without approval. Apply approved work only; refresh lockfile for those pins.

## Out of scope here

- `typescript` 5.9.3 / `@typescript/native-preview` → separate plan: `docs/plans/typescript-7-migration.md`
- `typebox` stay 1.1.38 (Pi still pins 1.1.38)
- `@types/node` 26.x (stay 22-track)
- `image-size` 2.0.2, `smol-toml` 1.7.0 (current)

## Approved — apply batch

| Package | Manifest | From | To | Status |
| --- | --- | --- | --- | --- |
| `@earendil-works/pi-ai` | root dev | 0.82.0 | 0.82.1 | **applied** (user override of `min-release-age=2`) |
| `@earendil-works/pi-coding-agent` | root dev | 0.82.0 | 0.82.1 | **applied** |
| `@earendil-works/pi-tui` | root dev | 0.82.0 | 0.82.1 | **applied** |
| `vitest` | root dev | 4.1.9 | 4.1.10 | **applied** |
| `@types/node` | root dev | 22.19.19 | 22.20.1 | **applied** |
| `oxfmt` | root dev + mise `npm:oxfmt` | 0.57.0 | 0.60.0 | **applied** |
| `oxlint` | root dev + mise `npm:oxlint` | 1.72.0 | 1.75.0 | **applied** |
| `@toon-format/toon` | agent dep | 2.3.0 | **remove** | **applied** — appshot compact JSON |

### Follow-on code (same apply)

- `packages/agent/extensions/appshot/index.ts` — drop toon `encode`; compact `JSON.stringify`
- appshot test + tool description + README — TOON → JSON
- Remove pin from `packages/agent/package.json`

Optional later (not this batch): Pi 0.82.1 `outputPad` for custom message renderers.

## Decisions log

- 2026-07-25: Approved Pi 0.82.1, vitest 4.1.10, @types/node 22.20.1.
- 2026-07-25: Skip @types/node 26.x.
- 2026-07-25: Remove `@toon-format/toon`; appshot compact JSON (not 2.3.1/4.0).
- 2026-07-25: Skip typebox; stay 1.1.38 until Pi moves.
- 2026-07-25: Approved oxfmt 0.60.0 + oxlint 1.75.0 + matching mise pins.
- 2026-07-25: TS7 / drop native-preview deferred to `docs/plans/typescript-7-migration.md`.
- 2026-07-25: Apply batch started. Pi 0.82.1 initially blocked by `min-release-age=2`; other pins + toon removal applied first.
- 2026-07-25: User approved Pi install despite age gate. Pi trio **0.82.1** applied via `npm install --before=2099-01-01`.

## Apply checklist (when told to apply)

1. Edit only approved manifests + mise oxfmt/oxlint + appshot toon removal surface.
2. `npm install` / lockfile refresh for touched pins only.
3. Run normal validation for touched surface (format churn OK if oxfmt-only).
4. No drive-by refactors; no unapproved pins; do not touch typescript pins here.
