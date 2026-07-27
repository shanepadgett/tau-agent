# Cold start — any Explore rewrite task

Fresh context window. Read this first, then the single task README you were assigned, then only the specs and code paths that task lists.

## What you are building

Explore structural tools on in-process `web-tree-sitter` (WASM). Product law: `docs/plans/explore-specs/`. Delete law: `docs/plans/explore-specs/stripped.md`. Full plan index: `docs/plans/explore-wasm-rewrite/README.md`.

**Explore registers 12 tools only:**  
`outline` `show` `discover` `ast_search` `deps` `reverse_deps` `callers` `callees` `references` `implementations` `impact` `context`

**Pi owns:** `ls` `find` `grep` `read` (+ patch/edit/write/bash). Do not reimplement them. Large full Pi `read` → outline is a `tool_result` hook (task 12), not an Explore `read` tool.

## Fixed architecture (do not reopen)

1. In-process engine. No child process, no native worker, no protocol.
2. **Language separation (bold product claim):** adding a language is **two required edits** only — (1) `ast/languages/<lang>.ts` (or a sibling under `languages/` for large hooks), (2) one `register` line in `ast/registry.ts`. Grammar languages also need a pin/artifact under `ast/grammars/` (toolchain, not tools). Capability hooks (`resolvePackageSurface`, `resolveFileDep`, callEdges tables, `importNoiseIdentifiers`) live **on that adapter**. **Never** put language keywords, package layouts, re-export syntax, or `language ===` / extension switches in `tools/`, `queries/`, `format/`, `engine.ts`, or other shared base files.
3. **Language coverage law:** a task that lands user-facing tool behavior must work for **every registered corpus language that can support the concept**, with real adapter hooks — not TS-first plus capability errors for the rest. Capability-unavailable is only for languages where the concept does not apply (example: Markdown has no file-import graph). Each task’s Done when lists the LIVE-PROVE languages it claims; “adapters exist but we only proved TS” is incomplete.
4. Parse → plain `FileIr` → `tree.delete()` immediately. Cache IR by `(path, contentHash)`. Never cache `Tree`.
5. Signature = byte slice of real source. Never rebuild from strings / regex.
6. Identity = `path` + `name` + optional `line`. No numeric locators.
7. Formatters pure (IR/view → string). Tools thin (schema + wire + bounded emit).
8. No Explore writes. No read-gate. No read-stats. No complete-file unchanged/diff cache.
9. Register each tool when it works. Composition root: `packages/agent/extensions/explore/index.ts`.
10. Model text via `packages/agent/shared/bounded-text-result.ts`. Overflow via `temporary-output-store.ts`. Do not copy `DEFAULT_MAX_*` into call sites.
11. Repo rules: `AGENTS.md` (strict TS, no `any`, no `!`, top-level imports, extension settings path, no manual schema edit).

## Tests and validation

- **Do not write new unit/integration tests** for this rewrite. No new `*.test.ts` under explore except the existing grammar smoke from task 01 (leave it alone).
- **Do not** invent fixture harnesses “for later.”
- After the task: leave code so auto **`mise run check:ts`** (silent runner) stays green — types, lint, format, fallow. That is enough for “build good.”
- **Live prove** what the task “Done when” says, after `/reload`, by invoking the **real registered harness tool** (not a bun script, not a private query import) against the **reference corpus** in [`LIVE-PROVE.md`](LIVE-PROVE.md). This monorepo alone is not enough once a tool is registered. Languages the task touches must appear in those calls. Scaffold-only tasks with no tool yet: check:ts green + loads is enough.
- Archive `docs/plans/explore-archive/` is **read-only prior art**. Never paste it.
- Reference checkouts are **read-only**. Never edit them.

## How to run one task in a new window

1. Read this file.
2. Read `docs/plans/explore-wasm-rewrite/<NN-name>/README.md` only for your task.
3. Read every spec path that task lists (under `docs/plans/explore-specs/`).
4. Skim on-disk code the task depends on (previous tasks’ files). Do not re-read the whole plan set.
5. Implement only that task’s file list and wiring. No bonus tools, settings, or “while I’m here.”
6. Unreachable modules: `// fallow-ignore-file unused-file -- wired by <task>` until wired; remove when reachable from `index.ts`.
7. Stop when “Done when” is met and check:ts would be green. Remind human `/reload` if extension surface changed.
8. Live prove via harness tools on [`LIVE-PROVE.md`](LIVE-PROVE.md) corpus paths for every language the task touches. Do not stop at monorepo-only pokes when references exist.
9. Do not start the next task unless asked.

## Task order (critical path)

```text
00 scaffold → 02 engine → 03 TS/Go adapters → 05 identity → 06 outline/show
  → then 07/08/09/10/12 as listed; 04 adapters and 11 ast_search must not block 06
01 grammars = DONE
13 assembly → 14 cleanup
```

## Anti-patterns (stop if you start doing these)

- God factory owning many tools in one closure
- Locators, orientation gate, blocked-read errors
- Explore `ls`/`find`/`grep`/`read` tools
- Signature pretty-print by regex
- Second parser or dual language stack
- **Language soup in shared code** — TS/Go/Rust keywords, `package.json`, re-export regex, or extension lists inside tools/queries/format/engine
- **TS-only product behavior** when other corpus languages can support the same tool via adapter hooks
- Copy-paste four relationship pipelines
- Unit test suite “to be safe”
- Reading/editing `packages/agent/schemas/tau.schema.json` by hand

## Historical only (do not implement from these)

- `docs/plans/ast-explore-architecture-rewrite.md` (superseded product bits)
- `docs/plans/explore-review-rok.md` (autopsy)
- `docs/plans/wasm-tree-sitter-extension.md` (research)
