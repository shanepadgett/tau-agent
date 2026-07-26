# Task 09 — `callers`, `callees`, `references`, `implementations`

## Cold start

Fresh window: read [`../COLD-START.md`](../COLD-START.md), this file, `explore-specs/graph/relationships.md` (full), identity + file-graph + engine. **No new tests.** One pipeline, four tool names. Live on TS in-repo. `check:ts` green.

Depends on: 05, 08.

## Goal

The four relationship tools over one shared pipeline. Register when they work. There is **no** `tests` tool (`stripped.md`).

Spec: `explore-specs/graph/relationships.md` — the shared contract section is normative for params and output.

## Files

```text
packages/agent/extensions/explore/ast/graph/occurrences.ts   scope scan → name occurrences with syntactic context
packages/agent/extensions/explore/ast/graph/relationships.ts one query fn with an operation enum
packages/agent/extensions/explore/ast/format/relationships.ts
packages/agent/extensions/explore/ast/tools/relationships.ts exports the four thin tool defs
```

Four tools, one implementation. Do not write four pipelines (see `ast-explore-architecture-rewrite.md`, anti-pattern 5).

## Mechanism (syntactic + honest certainty — no type checker)

1. Resolve target via task 05; stop at candidates on ambiguity, per spec. Target must lie inside scope `path`.
2. `occurrences.ts`: stream scope files; for files whose source contains the bare name (cheap `includes` prefilter), parse via engine and collect identifier nodes matching the name with classification from the parent node kind: call expression callee → `call`; type position → `typeUse`; extends/implements clause → `implementation`; import/export site → `reExport`/`import`; else `reference`. Each adapter contributes its identifier + parent-kind mapping through a small per-language table in its own file (capability `callEdges`).
3. Certainty: `exact` when the occurrence's file imports the target's defining file (TS/TSX via task 08 graph) or occurrence is in the defining file; `inferred` when the name is unique in scope; `ambiguous` when multiple same-name declarations exist in scope — list bounded competitors, mark non-actionable.
4. Per-operation filter: `callers` = inbound `call` (types: constructions/implementors); `callees` = occurrences **inside the target's body span** resolved outward to their own declarations, direct only; `references` = all reference/typeUse/reExport sites; `implementations` = inheritance sites + conservative same-name method overrides in implementing types.

## Output

Resolved target stated once at top (path, name, kind, line). Sites grouped by file, line + relationship kind + short exact preview (the occurrence's source line, trimmed). Certainty label only when not `exact`. Footers only for omissions/ambiguity/parser trust issues/budgets. Complete-block bounding + temp overflow.

## Done when

Live on TS in this repo: direct calls, method calls, type uses, re-export, ambiguous duplicate name, callees from a body, implementations via `implements`/`extends`. Empty and budget paths sane.
