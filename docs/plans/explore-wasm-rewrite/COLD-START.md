# Cold start — any Explore rewrite task

Fresh context window. Read this first, then the single task README you were assigned, then only the specs and code paths that task lists.

## What you are building

Explore structural tools on in-process `web-tree-sitter` (WASM). Product law: `docs/plans/explore-specs/`. Delete law: `docs/plans/explore-specs/stripped.md`. Full plan index: `docs/plans/explore-wasm-rewrite/README.md`.

**Explore registers 12 tools only:**  
`outline` `show` `discover` `ast_search` `deps` `reverse_deps` `callers` `callees` `references` `implementations` `impact` `context`

**Pi owns:** `ls` `find` `grep` `read` (+ patch/edit/write/bash). Do not reimplement them. Large full Pi `read` → outline is a `tool_result` hook (task 12), not an Explore `read` tool.

## Fixed architecture (do not reopen)

1. In-process engine. No child process, no native worker, no protocol.
2. Language = one adapter file + one registry line. Tools never `language ===`.
3. Parse → plain `FileIr` → `tree.delete()` immediately. Cache IR by `(path, contentHash)`. Never cache `Tree`.
4. Signature = byte slice of real source. Never rebuild from strings / regex.
5. Identity = `path` + `name` + optional `line`. No numeric locators.
6. Formatters pure (IR/view → string). Tools thin (schema + wire + bounded emit).
7. No Explore writes. No read-gate. No read-stats. No complete-file unchanged/diff cache.
8. Register each tool when it works. Composition root: `packages/agent/extensions/explore/index.ts`.
9. Model text via `packages/agent/shared/bounded-text-result.ts`. Overflow via `temporary-output-store.ts`. Do not copy `DEFAULT_MAX_*` into call sites.
10. Repo rules: `AGENTS.md` (strict TS, no `any`, no `!`, top-level imports, extension settings path, no manual schema edit).

## Tests and validation

- **Do not write new unit/integration tests** for this rewrite. No new `*.test.ts` under explore except the existing grammar smoke from task 01 (leave it alone).
- **Do not** invent fixture harnesses “for later.”
- After the task: leave code so auto **`mise run check:ts`** (silent runner) stays green — types, lint, format, fallow. That is enough for “build good.”
- **Live prove** only what the task “Done when” says: `/reload`, poke tools or APIs on this repo. If the task has nothing live to poke yet (e.g. scaffold only), check:ts green + loads is enough. Move on.
- Archive `docs/plans/explore-archive/` is **read-only prior art**. Never paste it.

## How to run one task in a new window

1. Read this file.
2. Read `docs/plans/explore-wasm-rewrite/<NN-name>/README.md` only for your task.
3. Read every spec path that task lists (under `docs/plans/explore-specs/`).
4. Skim on-disk code the task depends on (previous tasks’ files). Do not re-read the whole plan set.
5. Implement only that task’s file list and wiring. No bonus tools, settings, or “while I’m here.”
6. Unreachable modules: `// fallow-ignore-file unused-file -- wired by <task>` until wired; remove when reachable from `index.ts`.
7. Stop when “Done when” is met and check:ts would be green. Remind human `/reload` if extension surface changed.
8. Do not start the next task unless asked.

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
- Copy-paste four relationship pipelines
- Unit test suite “to be safe”
- Reading/editing `packages/agent/schemas/tau.schema.json` by hand

## Historical only (do not implement from these)

- `docs/plans/ast-explore-architecture-rewrite.md` (superseded product bits)
- `docs/plans/explore-review-rok.md` (autopsy)
- `docs/plans/wasm-tree-sitter-extension.md` (research)
