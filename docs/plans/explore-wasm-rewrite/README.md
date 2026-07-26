# Explore WASM rewrite — task plan

Rebuild Explore's structural engine on `web-tree-sitter` (WASM, in-process) and deliver the 16-tool spine defined in [`docs/plans/explore-specs/`](../explore-specs/README.md). The native Rust worker was dead on arrival under corporate endpoint policy (see [`wasm-tree-sitter-extension.md`](../wasm-tree-sitter-extension.md)).

**Status 2026-07-26: the old extension is already gone.** Source and tests are frozen at [`docs/plans/explore-archive/`](../explore-archive/README.md); the tau-ast Rust crate, its CI job, cargo tasks, and packaging were deleted. `autoread.ts`/`full-file-knowledge.ts` survive trimmed in `packages/agent/shared/` (autoread registration temporarily lives in the context-pruning extension). Until tasks land, the agent runs on Pi built-ins plus `bash`; the scout/review subagents and context-sync run on a reduced `read`+`bash` toolset.

## Normative inputs

- Product contract: `docs/plans/explore-specs/` — every task lists the spec files that are its acceptance criteria.
- Delete list: `docs/plans/explore-specs/stripped.md` — reintroducing anything on it is a bug.
- Architecture rationale: `docs/plans/ast-explore-architecture-rewrite.md`, `docs/plans/explore-review-rok.md`.

## Architecture decisions (fixed — do not relitigate in tasks)

1. **Engine is in-process TypeScript.** `web-tree-sitter` runtime + pinned grammar `.wasm` artifacts. No child process, no `worker_threads`, no protocol, no codec, no protocol version. The specs' word "worker" maps to this in-process engine object; it "advertises" languages by exposing the adapter registry.
2. **Cooperative yielding, not threads.** Directory operations `await` a macrotask between file units and check `AbortSignal` per unit. Escalate to `worker_threads` only if measured latency demands it — that is a separate future decision, not part of this plan.
3. **One language stack.** Adapters, IR, formatting, and tools all live in TypeScript under `packages/agent/extensions/explore/ast/`. Signatures are byte slices of real source, never reconstructed from strings.
4. **Canonical IR, extracted eagerly.** Parse → extract plain-JS `FileIr` → `tree.delete()` immediately. Never cache `Tree` objects (WASM heap, not GC'd). Cache IR keyed by `(path, contentHash)`.
5. **Identity is `path` + `name` (+ `line`).** No numeric locators anywhere (`explore-specs/cross/identity.md`).
6. **No Explore write tools.** Edits are harness `patch`/`edit`/`write` (`stripped.md`).
7. **Grammar artifacts are pinned; prebuilt beats rebuilt.** Six grammars plus the runtime resolve from npm packages (`@vscode/tree-sitter-wasm`, `web-tree-sitter`); kotlin/swift/odin are committed artifacts maintained by `packages/agent/scripts/build-grammars.ts` (see task 01). Never built on a developer machine at runtime.
8. **Markdown is a hand-written heading scanner**, not a tree-sitter grammar (external-scanner incompatibility with `web-tree-sitter`).
9. **Platform limitation disappears.** WASM runs wherever Node runs; the darwin-arm64 restriction in `explore-specs/cross/system.md` becomes obsolete. Structural tools work on all hosts. This is a spec deviation in the good direction; note it, do not preserve the restriction.

## Keep-green strategy

`packages/agent/extensions/explore/` no longer exists; the rewrite builds it fresh. There is no old system to collide with, so **register each tool as soon as it works** — no staged flip. Task README lines saying "staged, registered in task 13" predate the archive and are superseded by this rule. Use `// fallow-ignore-file unused-file -- wired by <task>` only for modules genuinely not yet reachable from `index.ts`, and remove the header in the wiring task. Every task must leave `mise run check:ts` green.

## Task order and dependencies

```text
00-restore-fs-tools         (immediate: ls/find/grep back from the archive)
01-grammar-toolchain        (go/no-go gate: WASM loads on the managed Mac)
02-engine-core              (needs 01)
03-adapters-typescript-go   (needs 02)
04-adapters-remaining       (needs 03)
05-identity-resolution      (needs 03)
06-outline-show             (needs 05)
07-discover                 (needs 06)
08-file-graph               (needs 03)
09-relationships            (needs 05, 08)
10-impact-context           (needs 09)
11-ast-search               (needs 02; research gate inside)
12-read-autoread-settings   (needs 06)
13-assembly                 (needs 04, 07, 10, 11, 12)
14-cleanup                  (needs 13)
```

03→04 and 06→07/12 can overlap once interfaces settle. 11 is the riskiest task; start its research spike early.

## Shared invariants for every task

- Strict TS, erasable syntax, no `any`, no `!`, top-level imports only (`AGENTS.md`).
- Model-visible text goes through the shared bounded handler (`packages/agent/shared/bounded-text-result.ts`); never copy `DEFAULT_MAX_BYTES`/`DEFAULT_MAX_LINES` into call sites. Overflow to `packages/agent/shared/temporary-output-store.ts`.
- Agent text obeys `explore-specs/cross/output-density.md`: per-file grouping, exact snippets, no scores, no arg echoes, footers only for real omissions/limits.
- Traversal budgets (2000 files / 64 MiB / depth 32 / 20 s) are separate from output limits (`explore-specs/cross/path-conventions.md`). Reuse `traverse.ts` restored by task 00 (original: `docs/plans/explore-archive/explore/traverse.ts`) for ignore-aware walks.
- Formatters are pure functions: IR in, string out. No side effects, no registration, no state.
- Unit tests per task via vitest (`npm run test:unit` runs through the auto ts-check; do not run it manually).
