# Relationship tools

Shared contract for:

- `callers`
- `callees`
- `references`
- `implementations`

There is **no** `tests` tool.

## Purpose

- Expand a path+name target across a repository/subtree into related source sites.
- Be honest about exact vs inferred vs ambiguous resolution.
- Keep ambiguous results visible but non-actionable for blind edits.

## Parameters (all four tools)

- `path` (required string) — directory scope (repo/package/subtree)
- Target identity (required) per [identity.md](../cross/identity.md):
  - `targetPath` (optional string) — defining file when known
  - `name` (required string)
  - `line` (optional number)
- `resultLimit` (required int 1…100)

If `targetPath` is omitted, resolve `name` within `path` scope; ambiguity returns candidates and does not run the relationship walk.

## Common preconditions

- Scope `path` must be a directory.
- Target must resolve to exactly one declaration under [identity.md](../cross/identity.md), or the tool stops at candidates.
- Declaration must lie inside the requested scope.

## Per-tool meaning

### `callers`

- Syntactic call sites of the declaration.
- For type targets: implementors / constructions / kind-appropriate inbound uses the adapter supports.

### `callees`

- Direct callees inside the target declaration’s executable/body scope.
- For type targets: ancestor types / kind-appropriate outbound edges the adapter supports.
- Direct only (no depth param in v1).

### `references`

- Direct references and type usages of the declaration.
- Includes re-export sites when classified as such.

### `implementations`

- Syntactic inheritance / implementation relationships and conservative same-name overrides where supported.

## Agent output

Per [output-density.md](../cross/output-density.md):

- Group sites **by file** (path header once; line rows under it).
- Each site row: line/range, relationship kind, short **exact** preview snippet, name if useful.
- Certainty label only when not `exact` (`inferred` / `ambiguous`).
- Ambiguous → list bounded competitor path+name+line+signature; mark non-actionable. No silent pick.
- Resolved target stated once at top (path, name, kind, line) — not repeated on every row.
- No scores, no actionable boolean spam when implied by certainty, no classification enums unless they change the decision (`generated` / `reExport` only when known and useful), no reason paragraphs by default.

## Empty / limits

- No matches → one-line empty message.
- Footers only for omissions, noteworthy ambiguity collapse, parser issues, budgets.
- Scope walks honor [path-conventions.md](../cross/path-conventions.md) where directory traversal applies.
- Shared parse/graph cache per [system.md](../cross/system.md).
- Complete-block bounding + temp overflow ([bounded-output.md](../cross/bounded-output.md)).

## Errors / edge cases

- Ambiguous or missing target
- Non-directory scope
- Declaration outside scope
- Worker unavailable
- Cancellation

## Non-goals

- Not a full IDE type-checker
- Does not write files
- Does not find tests
