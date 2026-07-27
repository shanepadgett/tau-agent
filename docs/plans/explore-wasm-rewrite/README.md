# Explore WASM rewrite — task plan

Rebuild Explore's structural engine on `web-tree-sitter` (WASM, in-process) and deliver the **AST tool spine** defined in [`docs/plans/explore-specs/`](../explore-specs/README.md). The native Rust worker was dead on arrival under corporate endpoint policy (see [`wasm-tree-sitter-extension.md`](../wasm-tree-sitter-extension.md)).

**Status 2026-07-26: the old extension is already gone.** Source and tests are frozen at [`docs/plans/explore-archive/`](../explore-archive/README.md); the tau-ast Rust crate, its CI job, cargo tasks, and packaging were deleted. `autoread.ts`/`full-file-knowledge.ts` survive trimmed in `packages/agent/shared/` (autoread registration temporarily lives in the context-pruning extension). Until tasks land, the agent runs on Pi built-ins plus `bash`; the scout/review subagents and context-sync run on a reduced `read`+`bash` toolset.

**Product cut (2026-07-26):** Explore does **not** reimplement `ls` / `find` / `grep` / `read`. Pi owns those. Explore ships structural tools only. Large full `read` of supported source becomes outline via a `tool_result` hook on Pi's built-in `read` (see task 12) — full body never enters model context on that path.

## Normative inputs

- **Cold start (fresh window):** [`COLD-START.md`](COLD-START.md) — read first on every task; then only that task’s README + its listed specs + prior code on disk.
- Product contract: `docs/plans/explore-specs/` — every task lists the spec files that are its acceptance criteria.
- Delete list: `docs/plans/explore-specs/stripped.md` — reintroducing anything on it is a bug.
- Architecture rationale (historical): `docs/plans/ast-explore-architecture-rewrite.md`, `docs/plans/explore-review-rok.md` — autopsy only.

Each task README is written to stand alone for implementation **given** COLD-START + listed specs + code already landed by prior tasks. Do not require chat history.

## Architecture decisions (fixed — do not relitigate in tasks)

1. **Engine is in-process TypeScript.** `web-tree-sitter` runtime + pinned grammar `.wasm` artifacts. No child process, no `worker_threads`, no protocol, no codec, no protocol version. The specs' word "worker" maps to this in-process engine object; it "advertises" languages by exposing the adapter registry.
2. **Cooperative yielding, not threads.** Directory operations `await` a macrotask between file units and check `AbortSignal` per unit. Escalate to `worker_threads` only if measured latency demands it — that is a separate future decision, not part of this plan.
3. **One language stack + hard separation.** Adapters, IR, formatting, and tools all live in TypeScript under `packages/agent/extensions/explore/ast/`. Signatures are slices of real source, never reconstructed from strings. **Bold claim:** a new language is **two required code edits** — `ast/languages/<lang>.ts` (+ optional sibling under `languages/` for large hooks) and one line in `ast/registry.ts` — plus a grammar pin/artifact when using tree-sitter. Tools/queries/format/engine stay language-agnostic; capability hooks (`packageSurface`, `fileDeps`/`resolveFileDep`, `callEdges`, import-noise sets) attach to the adapter. Violating this is a stop-ship for any task.
3a. **Language coverage law.** User-facing tools work for every registered corpus language that can support the concept. Adapter hooks carry language rules; shared code stays blind. Do not ship TS-first behavior with capability errors for Go/Rust/Java/… when those languages can implement the hook. Capability-unavailable only when the concept does not apply (e.g. Markdown file deps). Task Done when lists LIVE-PROVE languages claimed.
4. **IR offsets are UTF-16 code units into the decoded source string.** Adapters emit `node.startIndex`/`node.endIndex` as-is; consumers slice with `source.slice(...)`. No UTF-8 conversion, no `Buffer` outside engine content hashing. `FileSource.source` is the decoded string every offset indexes into.
5. **Canonical IR, extracted eagerly.** Parse → extract plain-JS `FileIr` → `tree.delete()` immediately. Never cache `Tree` objects (WASM heap, not GC'd). Cache IR keyed by `(path, contentHash)`.
6. **Identity is `path` + `name` (+ `line`).** No numeric locators anywhere (`explore-specs/cross/identity.md`).
7. **No Explore write tools.** Edits are harness `patch`/`edit`/`write` (`stripped.md`).
8. **No Explore filesystem tools.** `ls` / `find` / `grep` / `read` stay Pi built-ins. Density wrappers are future work only if live use proves pain — not this rewrite.
9. **Large-read policy is a hook, not a read tool.** On Pi `tool_result` for full `read` of registered non-Markdown source over threshold: replace result content with outline + one nudge. Success, not block. Ranged/small/Markdown/unsupported pass through. No complete-file unchanged/diff cache. No transcript replay.
10. **Grammar artifacts are pinned; prebuilt beats rebuilt.** Six grammars plus the runtime resolve from npm packages (`@vscode/tree-sitter-wasm`, `web-tree-sitter`); kotlin/swift/odin are committed artifacts maintained by `packages/agent/scripts/build-grammars.ts` (see task 01). Never built on a developer machine at runtime.
11. **Markdown is a hand-written heading scanner**, not a tree-sitter grammar (external-scanner incompatibility with `web-tree-sitter`).
12. **Platform limitation disappears.** WASM runs wherever Node runs; the darwin-arm64 restriction in older drafts is obsolete. Structural tools work on all hosts.

## Keep-green / live-prove strategy

`packages/agent/extensions/explore/` rebuilds fresh. **Register each AST tool as soon as it works** — no staged flip. Use `// fallow-ignore-file unused-file -- wired by <task>` only for modules genuinely not yet reachable from `index.ts`, and remove the header in the wiring task. Every task must leave `mise run check:ts` green.

**No new unit tests for this rewrite.** Prove each phase live after `/reload` by calling the **real harness tool** against the fixed reference corpus in [`LIVE-PROVE.md`](LIVE-PROVE.md) (`~/.local/share/tau-agent/references/`: pi, excalidraw, go-tui, ast-bro, Avalonia, guava, okio, swift-collections, Odin). Cover every language the task touches. This monorepo is optional extra TS smoke, not a substitute. Existing grammar smoke test from task 01 stays; do not grow a vitest suite per task. Auto `check:ts` still runs (types, lint, fallow) — that is not product behavior testing.

## Task order and dependencies

```text
00-scaffold                 (extension shell + ignore-aware traverse helper; no tools)
01-grammar-toolchain        DONE — WASM loads on the managed Mac
02-engine-core              (needs 00, 01)
03-adapters-typescript-go   (needs 02)
05-identity-resolution      (needs 03)
06-outline-show             (needs 05)          ← first live structural prove
07-discover                 (needs 06)
08-file-graph               (needs 03, 04 — all programming languages resolve)
09-relationships            DONE — IR CallSite/bases/bindings + queryRelationships (needs 05, 08)
10-impact-context           (needs 09; compose only — see 09 DONE banner)
12-read-hook-settings       (needs 06)          ← Pi read tool_result → outline
04-adapters-remaining       (needs 03; after 06 preferred so spine is proven)
11-ast-search               (needs 02; research gate inside; can trail)
13-assembly                 (needs 04, 07, 10, 11, 12)
14-cleanup                  (needs 13)
```

Critical path to a usable product: **00 → 02 → 03 → 05 → 06**, then 12 for read policy. Bulk adapters (04) and `ast_search` (11) must not delay outline/show.

03→04 and 07/08/12 can overlap once interfaces settle. 11 is the riskiest task; start its research spike early if desired.

## Explore tool spine (this rewrite)

`outline` `show` `discover` `ast_search`  
`deps` `reverse_deps`  
`callers` `callees` `references` `implementations`  
`impact` `context`

**12 tools** + Pi `read` outline-substitution hook + pre-turn guidance + autoread outline path.

Harness keeps: `ls` `find` `grep` `read` `patch`/`edit`/`write` `bash`.

## Shared invariants for every task

- Strict TS, erasable syntax, no `any`, no `!`, top-level imports only (`AGENTS.md`).
- Model-visible text goes through the shared bounded handler (`packages/agent/shared/bounded-text-result.ts`); never copy `DEFAULT_MAX_BYTES`/`DEFAULT_MAX_LINES` into call sites. Overflow to `packages/agent/shared/temporary-output-store.ts`.
- Agent text obeys `explore-specs/cross/output-density.md`: per-file grouping, exact snippets, no scores, no arg echoes, footers only for real omissions/limits.
- Traversal budgets (2000 files / 64 MiB / depth 32 / 20 s) are separate from output limits (`explore-specs/cross/path-conventions.md`). Reuse `traverse` from task 00 for ignore-aware walks.
- Formatters are pure functions: IR in, string out. No side effects, no registration, no state.
- Live validation per task README "Done when". No new vitest product suites.
