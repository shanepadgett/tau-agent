# Task 06 — `outline` and `show` tools

## Cold start

Fresh window: read [`../COLD-START.md`](../COLD-START.md), this file, every spec listed below, then identity + engine + adapters + `packages/agent/shared/bounded-text-result.ts` + a thin Tau tool (e.g. web/patch) for `defineTool`/row-state patterns. **No new tests.** Register tools now. Live after `/reload` per Done when. `check:ts` green.

Depends on: 05.

## Goal

The two core shape tools. **Register as soon as they work** (parent plan rule). First live prove of the structural spine.

Specs: `explore-specs/shape/outline.md`, `explore-specs/shape/show.md`, `explore-specs/cross/output-density.md`, `explore-specs/cross/bounded-output.md`.

## Files

```text
packages/agent/extensions/explore/ast/queries/outline.ts   pure: IR(s) → OutlineView
packages/agent/extensions/explore/ast/format/outline.ts    pure: OutlineView → string units
packages/agent/extensions/explore/ast/tools/outline.ts     schema + wiring only
packages/agent/extensions/explore/ast/queries/show.ts
packages/agent/extensions/explore/ast/format/show.ts
packages/agent/extensions/explore/ast/tools/show.ts
```

Tool files are thin: typebox schema, param normalization (strip leading `@` per `path-conventions.md`), one query call, one format call, bounded emission. For `packages/agent/shared/tool-row-state.ts` usage and TUI render conventions (`packages/agent/docs/tui.md`), follow patterns in other Tau extensions — never hardcode keybinding hints. Archive is prior art only.

## `outline`

- Params: `path` (required), `includePrivate`, `includeDocs`, `names[]`, `recursive` — exactly the spec's surface.
- File mode: single `FileIr` → signature rows with `L<start>-<end>` ranges, indentation for nesting, docs lines only when `includeDocs`. No path chrome on single file.
- Directory mode: one-level supported files, per-file units (path header once).
- Recursive mode: `scan.ts` stream; format each file as a complete unit; feed units to the bounded handler with complete-block retention; complete overflow to the temporary store with the standard notice. Budget trips become one footer line naming the budget.
- Markdown: heading rows with section ranges (scanner from task 02).
- `names[]` filters by exact `name`/`qualifiedName`; empty result → one-line message per spec.
- Side effect: outlined files' IR lands in the cache (free — engine does it).

## `show`

- Params: `targets[] { path, name, line? }` (min 1), `view` enum, `contextLines` (declaration view only — error otherwise).
- Resolve every target via task 05 **before** emitting anything. Any ambiguous/missing target → whole call errors with that target's candidate list; no partial bodies (spec is explicit).
- Views are byte slices: `signature` (doc span excluded, body excluded), `signatureWithDocs` (doc span included; warn once when absent), `declaration` (full decl span, ± `contextLines` source lines), `declarationWithImports` (decl + the file's import statements that mention identifiers appearing in the decl slice — literal identifier intersection is acceptable v1; do not build a resolver).
- Over budget → **hard error** telling the agent to request fewer targets. Never truncate a batch (`bounded-output.md` show special case).
- Dedupe identical targets.

## Done when

After `/reload`: recursive `outline` on a real package path; `show` a known symbol all four views; ambiguity errors with candidates; large recursive outline hits bound/overflow cleanly.
