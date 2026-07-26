# `outline`

## Purpose

- Declarations/structure without bodies.
- File, one-level directory, or recursive tree.
- Line ranges so agents can `show` or ranged-`read` (no session IDs).

## Parameters

- `path` (required string)
- `includePrivate` (optional boolean, default false)
- `includeDocs` (optional boolean, default false)
- `names` (optional string[], min 1)
- `recursive` (optional boolean)

## Modes

- **File:** supported language file only.
- **Directory:** one-level package outline of supported files.
- **Recursive:** directory + `recursive: true`; ignore-aware walk under budgets ([path-conventions.md](../cross/path-conventions.md)).

## Agent output

Per [output-density.md](../cross/output-density.md):

- Signatures and structure only — no function/method bodies.
- Line ranges on declarations (`Lstart-end` or equivalent). **No locators** ([identity.md](../cross/identity.md), [stripped.md](../stripped.md)).
- Multi-file: **per-file units** with path once per file; nested decl lines under that file — not a flat `path:L` spam list.
- Single-file: no redundant path chrome.
- Structural rows (import/export/etc.) in source order when useful; not every noise row if it adds nothing.
- Parser recovery / non-certain decl warnings only when true.
- Markdown: headings with section ranges.
- Recursive: complete-block bounding + temp overflow ([bounded-output.md](../cross/bounded-output.md)); diagnostics as separate units; footers only on failure/limits.
- Empty: short no-declarations / no-matching-declarations message.

## Language coverage

- All engine-registered languages with outline capability ([system.md](../cross/system.md)).

## Side effects

- Refresh parse cache for outlined files.
- Large full `read` may return this shape ([read-policy.md](../cross/read-policy.md)).

## Errors / edge cases

- Unsupported type, recursive on non-dir, engine, cancel
- Cancel must not leave partial temp success

## Non-goals

- Not full source dump, not search, not write, not locators
