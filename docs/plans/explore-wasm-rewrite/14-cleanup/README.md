# Task 14 — Cleanup

## Goal

The old system was archived/deleted on 2026-07-26 (see `docs/plans/explore-archive/README.md`). This task reverses the interim compromises made then and sweeps the leftovers.

## Reverse the interim wiring

- Scout/review subagents (`packages/agent/extensions/subagent/agents/{scout,review}.md`): restore full tool lists using the new 16-tool names and rewrite their bodies for the new surface (they still describe locators, `symbol`, `api_discover`, `tests` — all gone per `stripped.md`).
- `CONTEXT_SYNC_REQUIRED_TOOLS` in `packages/agent/extensions/context/sync.ts`: restore `ls`/`find`/`grep`.
- `shared/autoread.ts`: registration moved into Explore in task 12 — confirm the context-pruning call is gone and the shared module only exports what prune/handoff/subagent consume.
- `.pi/extensions/tool-preview/widgets/`: delete previews for dead tools (`symbol.ts`, `locator-edits.ts`, `read-stats.ts`); refresh mock data in `outline.ts`, `api-discover.ts`, `ast-search.ts`, `autoread.ts`, and the fs-tool widgets to the new output shapes.

## Sweep

- `grep -ri "tau-ast\|locator\|read-stats\|orientation\|api_discover" packages/ .pi/extensions/ .github/ AGENTS.md` — every remaining hit is justified or removed (Pi upstream docs don't count).
- Run context-sync so `.pi/contexts` reflects the final file layout.
- `mise run check:ts` green; Fallow reports no dead files.
- `npm pack --dry-run` on `packages/agent` shows grammar `.wasm` files and no native binaries.

## Aftercare

Ask the user whether to delete the archive and plan artifacts: `docs/plans/explore-archive/`, `docs/plans/explore-wasm-rewrite/`, `docs/plans/wasm-tree-sitter-extension.md`, `docs/plans/ast-explore-architecture-rewrite.md`, `docs/plans/explore-review-rok.md` (specs in `docs/plans/explore-specs/` stay — they are living acceptance criteria unless the user moves them into `packages/agent/docs/`).
