# Task 14 — Cleanup

## Cold start

Fresh window: read [`../COLD-START.md`](../COLD-START.md), this file, `stripped.md`. Sweep dead names; fix subagents/previews. **No new tests.** `check:ts` green. Ask human before deleting plan/archive dirs.

Depends on: 13.

## Goal

The old system was archived/deleted on 2026-07-26 (see `docs/plans/explore-archive/README.md`). This task reverses the interim compromises made then and sweeps the leftovers.

## Reverse the interim wiring

- Scout/review subagents (`packages/agent/extensions/subagent/agents/{scout,review}.md`): restore tool lists using the **12** Explore structural names + Pi fs tools; rewrite bodies for the new surface (they still describe locators, `symbol`, `api_discover`, `tests`, Explore-owned read/ls — all gone or harness-owned per `stripped.md`).
- `CONTEXT_SYNC_REQUIRED_TOOLS` in `packages/agent/extensions/context/sync.ts`: use Pi `ls`/`find`/`grep` (or whatever the reduced set should be) — not Explore clones.
- `shared/autoread.ts`: registration moved into Explore in task 12 — confirm the context-pruning call is gone and the shared module only exports what prune/handoff/subagent consume.
- `.pi/extensions/tool-preview/widgets/`: delete previews for dead tools (`symbol.ts`, `locator-edits.ts`, `read-stats.ts`, Explore fs clones if any); refresh mock data in `outline.ts`, `api-discover.ts` → discover shape, `ast-search.ts`, `autoread.ts` to the new output shapes.

## Sweep

- `grep -ri "tau-ast\|locator\|read-stats\|orientation\|api_discover\|createExploreRead\|explore.*\bls\b" packages/ .pi/extensions/ .github/ AGENTS.md` — every remaining hit is justified or removed (Pi upstream docs don't count).
- Run context-sync so `.pi/contexts` reflects the final file layout.
- `mise run check:ts` green; Fallow reports no dead files.
- `npm pack --dry-run` on `packages/agent` shows grammar `.wasm` files and no native binaries.

## Carried items from the outline checkpoint review

- Delete any registry/engine surface still without callers (`registry.adapterForExtension`, `registry.capabilitiesFor`, `registry.registeredLanguages`, `engine.irForFile` — Fallow cannot see unused object members; check by grep).
- Simplify the engine `generation`/`assertLive` ceremony if `generation` still only changes in `shutdown()` — one `shutDown` boolean plus post-`await` checks is enough.
- Go adapter: defined types over non-struct types (`type UserID int`) currently outline as `struct` (`typeSpecKind` fallback). Pick a truthful kind deliberately (extend `DeclKind` or use `typeAlias`).

## Deferred test backlog (user decision: functionality first, tests at the very end)

One testing pass after the rewrite is functionally complete. Coverage that pass owes:

- adapter extraction per language: spans, doc attachment, export/default handling, visibility, degraded-parse recovery (fixture files + assertions on extracted `Decl` forests),
- markdown scanner: fences, heading nesting, section end lines,
- `identity.ts`: ambiguity, line filter, notFound,
- outline/show queries + formatting: name filtering, recursive footer, show views, `contextLines`, import matching,
- `traverse.ts`: budgets, ignore rules, hidden/noise filtering.

## Aftercare

Ask the user whether to delete the archive and plan artifacts: `docs/plans/explore-archive/`, `docs/plans/explore-wasm-rewrite/`, `docs/plans/wasm-tree-sitter-extension.md`, `docs/plans/ast-explore-architecture-rewrite.md`, `docs/plans/explore-review-rok.md` (specs in `docs/plans/explore-specs/` stay — they are living acceptance criteria unless the user moves them into `packages/agent/docs/`).
