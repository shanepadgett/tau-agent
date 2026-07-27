# Task 09 — `callers`, `callees`, `references`, `implementations`

## Cold start

Fresh window: read [`../COLD-START.md`](../COLD-START.md), [`../LIVE-PROVE.md`](../LIVE-PROVE.md), this file, `explore-specs/graph/relationships.md` (full), identity + file-graph + engine. **No new tests.** One pipeline, four tool names. Live per Done when. `check:ts` green.

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

## Interface (follow the `resolveFileDep` precedent — do not invent a new pattern)

The engine never leaks `Tree` objects and IR carries no identifier occurrences, so this task adds exactly two seams:

1. **Adapter hook** in `ast/adapter.ts`:

   ```ts
   export type OccurrenceKind = "call" | "typeUse" | "implementation" | "import" | "reExport" | "reference";
   export type Occurrence = {
    kind: OccurrenceKind;
    line: number;        // 1-indexed
    startOffset: number; // UTF-16, decision 12
    endOffset: number;
   };
   // On GrammarAdapter, next to resolveFileDep:
   /** Required when `capabilities.callEdges` is true. */
   readonly collectOccurrences?: (tree: Tree, source: string, name: string) => Occurrence[];
   ```

   Each adapter owns both halves: which node types count as identifiers for its grammar (`identifier`, `simple_identifier`, `type_identifier`, `field_identifier`, …) and the parent-kind → `OccurrenceKind` classification. Shared relationship code must not name a single tree-sitter node type. Markdown keeps `callEdges: false`.

2. **Engine method** `occurrencesForFile(path, name, signal)`: resolve adapter, parse with the engine's own parser lifecycle, call `collectOccurrences`, `tree.delete()` in `finally`, return plain data. The `Tree` never escapes the engine. No occurrence caching — the `source.includes(name)` prefilter in `occurrences.ts` keeps parse volume low; add caching only if live use proves it slow.

All eight programming adapters already declare `callEdges: true` — task is not done until all eight have real `collectOccurrences` implementations, not just TS/Go. Budget the classification tables per language like the extraction tables in task 04: read each grammar's `node-types.json`, do not guess.

## Mechanism (syntactic + honest certainty — no type checker)

1. Resolve target via task 05; stop at candidates on ambiguity, per spec. Target must lie inside scope `path`.
2. `occurrences.ts`: stream scope files (reuse `scan.ts` patterns); for files whose source contains the bare name (cheap `includes` prefilter), call `engine.occurrencesForFile`. Classification guidance per language: call expression callee → `call`; type position → `typeUse`; extends/implements/conformance/embedding clause → `implementation`; import/export site → `import`/`reExport`; else `reference`.
3. Certainty: `exact` when the occurrence's file imports the target's defining file (task 08 file graph, every `fileDeps` language) or occurrence is in the defining file; `inferred` when the name is unique in scope; `ambiguous` when multiple same-name declarations exist in scope — list bounded competitors, mark non-actionable.
4. Per-operation filter: `callers` = inbound `call` (types: constructions/implementors); `callees` = occurrences **inside the target's body span** (`bodyStartOffset`/`bodyEndOffset` from IR) resolved outward to their own declarations, direct only; `references` = all reference/typeUse/reExport sites; `implementations` = inheritance sites + conservative same-name method overrides in implementing types.

## Output

Resolved target stated once at top (path, name, kind, line). Sites grouped by file, line + relationship kind + short exact preview (the occurrence's source line, trimmed). Certainty label only when not `exact`. Footers only for omissions/ambiguity/parser trust issues/budgets. Complete-block bounding + temp overflow.

## Done when

After `/reload`, real `callers` / `callees` / `references` / `implementations` per [`../LIVE-PROVE.md`](../LIVE-PROVE.md):

- Full case set on TS corpus (`pi` and/or `excalidraw`): direct calls, method calls, type uses, re-export, ambiguous duplicate name, callees from a body, `implements`/`extends`.
- Every other programming corpus language with `callEdges` (Go, Rust, Java, Kotlin, C#, Swift, Odin): at least one real callers/references-style hit each — not capability errors. Adapter owns node-kind maps.
- Empty and budget paths sane.
