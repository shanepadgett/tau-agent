# Task 13 — Assembly

## Cold start

Fresh window: read [`../COLD-START.md`](../COLD-START.md), [`../LIVE-PROVE.md`](../LIVE-PROVE.md), this file, `explore-specs/session/guidance.md` + system lifecycle, then full `explore/index.ts` and remaining unwired modules. **No new tests.** Wire lifecycle/guidance/docs; remove fallow headers. Full live smoke. Optional `review` subagent once. `check:ts` green.

Depends on: 04, 07, 10, 11, 12 (or whatever subset is actually built — wire what exists, do not invent missing tools).

## Goal

Final composition: everything built in tasks 00–12 wired into one coherent extension with lifecycle, guidance, and docs. Most tools already registered incrementally; this task closes gaps.

## Steps (order matters)

1. Audit `packages/agent/extensions/explore/index.ts` as composition root. As of task 10 it already builds engine + graph once, lifecycle subscriptions, and registers **11/12** tools: `outline`/`show`/`discover`/`deps`/`reverse_deps`/`callers`/`callees`/`references`/`implementations`/`impact`/`context`. **Do not rebuild.** Remaining gap before/with this task: `ast_search` (11) if shipped; task 12 read hook + autoread. Compact lifecycle per `explore-specs/cross/system.md`. Pi keeps `ls`/`find`/`grep`/`read`.
2. Engine shutdown (WASM object cleanup) on session shutdown; temporary store lifecycle as in other Tau tools.
3. Pre-turn guidance per `explore-specs/session/guidance.md`: bounded 4096-entry scan, detect languages, intersect with registry advertisement, inject the guidance content the spec lists. Must not mention locators, gates, Explore fs clones, or removed tools. No platform caveat — WASM runs everywhere.
4. Remove any remaining fallow staging headers from earlier tasks.
5. Docs in the same change (AGENTS.md rules): finalize `packages/agent/extensions/explore/README.md` (product level: 12 structural tools, path+name identity, Pi read overlay, all platforms); finalize the `## explore` section in `packages/agent/extensions/tau-help/help.md`.
6. Remind the user: extension changes need `/reload` before testing.

## Acceptance

- After `/reload`, full harness smoke per [`../LIVE-PROVE.md`](../LIVE-PROVE.md): recursive `outline`, `show`, `discover`, graph/relationship tools as registered, Pi `read` large-file outline substitution, `impact`, `context` — each on corpus scopes covering the languages still claimed, plus optional monorepo TS.
- `mise run check:ts` green (runs automatically).
- This is the one task where calling the `review` subagent is warranted (complex integration) — but only if the subagent extension is enabled in this session (it has been disabled at times during the rewrite). If unavailable, skip; do not re-enable it for this.
