# `discover`

## Purpose

- Find reusable declarations across a repo/package/subtree when path is unknown.
- Signatures only (no bodies).
- Package/public surface resolution when requested.
- Replaces `api_discover`. No session locators.

## Parameters

- `path` (required string) — directory scope only
- `query` (required tagged union; exactly one kind):
  - `exactName` — `{ kind, name }`
  - `prefixName` — `{ kind, name }`
  - `substringName` — `{ kind, name }`
  - `fuzzyName` — `{ kind, name, maxCandidates, maxWork }`
  - `declarationKind` — `{ kind, declarationKind }` (shared kind vocabulary)
  - `documentation` — `{ kind, terms[], maxCandidates, maxWork }`
- `surface` (required enum): `all` | `public` | `private` | `sourceExport` | `packageSurface`
- `resultLimit` (required int 1…100)

## Behavior

- Directory only; file path → error.
- Scan registered languages with discovery capability under traversal budgets ([system.md](../cross/system.md), [path-conventions.md](../cross/path-conventions.md)).
- Resolve export/package surface and re-export chains when the adapter can.
- Follow-up identity is path+name(+line) ([identity.md](../cross/identity.md)).

## Agent output

Per [output-density.md](../cross/output-density.md):

- Group candidates **by defining file**.
- Each candidate: name, kind, line range, signature; import/access path when known and useful for reuse.
- Visibility/surface only when it distinguishes candidates or surface mode makes it the point.
- Certainty/uncertainty only when not plain certain.
- **No** scores, rank indices, work counters, provenance essays, or locator fields.
- Budget/work limits: mention only when hit (agent must narrow query).
- Empty → one-line empty. Footers only for omissions/diagnostics/budgets.
- Complete-block bounding + temp overflow ([bounded-output.md](../cross/bounded-output.md)).

## Follow-up

- Caller uses path+name(+line) with `show`, graph tools, `impact`, or `context`.

## Errors / edge cases

- Non-directory scope
- Worker unavailable
- Cancellation

## Non-goals

- Not `outline` of a known file
- Not reference finding
- Does not write files
