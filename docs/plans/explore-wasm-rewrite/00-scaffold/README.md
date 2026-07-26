# Task 00 — Extension scaffold + traverse

## Cold start

Fresh window: read [`../COLD-START.md`](../COLD-START.md), then this file only. **No new tests.** Validate: extension loads; `check:ts` green. No live tools yet.

Depends on: nothing (01 grammars already on disk under `ast/grammars/`).

## Goal

Minimal `packages/agent/extensions/explore/` shell so later tasks have a home. **No Explore tools registered.** Pi keeps `ls` / `find` / `grep` / `read`.

Ignore-aware directory walk used by engine `scan` and later directory-scope tools. Write fresh — archive is prior art for ignore behavior only, never paste source.

## Behavior contract

Specs: `explore-specs/cross/path-conventions.md` (ignore rules, path display, traversal budgets as numbers the walker can enforce later). No fs tool specs — those tools are not Explore's.

## Steps

1. Create `packages/agent/extensions/explore/` with `index.ts` composition root (registers nothing structural yet; may no-op or only set up shared stores later tasks fill).
2. Implement `traverse.ts`: ignore-aware walk, `@` strip / cwd-relative display helpers, budget counters hooks. No tool schemas.
3. Product-level `README.md` stub in the extension dir (grows later). Do not claim fs tools.
4. If tau-help needs a placeholder `## explore` line, say structural tools landing — do not document fake tools.
5. Remind `/reload` only if the extension is loadable and empty registration is intentional.

## Done when

- Extension loads without error.
- Traverse helper is importable for task 02.
- Zero Explore tools shadow Pi builtins.
- `check:ts` green.
- No code copied from the archive.
