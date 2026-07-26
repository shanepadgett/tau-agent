# Explore archive (2026-07-26)

Frozen copy of the retired Explore extension. Nothing in here compiles, runs, or is referenced by live code. It exists as a reference for the WASM rewrite in [`docs/plans/explore-wasm-rewrite/`](../explore-wasm-rewrite/README.md).

Why retired: the extension depended on the native `tau-ast` Rust worker, which corporate endpoint policy kills on the managed Mac (init errors on every session start). The rewrite replaces it with a `web-tree-sitter` WASM engine.

## Contents

- `explore/` — the full extension source (`packages/agent/extensions/explore/` as of archival).
- `test/` — its vitest suite (`packages/agent/test/extensions/explore/`).

## What did NOT die with it

- `autoread.ts` and `full-file-knowledge.ts` had live consumers (`context-pruning`, `handoff`, `subagent`, `context`). Trimmed versions live at `packages/agent/shared/autoread.ts` and `packages/agent/shared/full-file-knowledge.ts`; `registerAutoread` is called from the context-pruning extension until the rewrite gives it a proper home. The full originals remain here.
- Generic test helpers (`createWorkspace`, `testRowState`, `testTheme`, …) moved to `packages/agent/test/helpers.ts`.

## Fully deleted (git history only)

- `packages/agent/native/tau-ast/` Rust crate, `packages/agent/scripts/package-tau-ast.ts`, the `native` CI job in `.github/workflows/publish.yml`, the cargo tasks in `mise.toml`, and the `native-bin` packaging entry.

Until the rewrite lands, the agent has no `ls`/`find`/`grep`/`read` replacements from Tau; Pi built-ins and `bash` cover the gap.
