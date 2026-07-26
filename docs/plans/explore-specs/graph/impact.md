# `impact`

## Purpose

- One-call blast radius for a symbol: callees, callers, file imports, file importers, transitive dependents.
- Default move before a non-trivial edit.
- Same backends as [relationships.md](relationships.md) callers/callees and [deps.md](deps.md) / [reverse-deps.md](reverse-deps.md).
- Session graph cache per [system.md](../cross/system.md).

## Parameters

- `path` (required string) — directory scope
- Target identity per [identity.md](../cross/identity.md): `targetPath?`, `name`, `line?`
- `depth` (optional int ≥ 1, default `2`)
- `mode` (optional, default `all`): `all` | `deps` | `dependents`

## Target resolution

- Exactly one declaration or stop with candidates.
- Callable and type targets; kind-appropriate edges per [relationships.md](relationships.md).

## Sections (empty dropped)

Header once: resolved target path, name, kind, line.

1. callees  
2. file imports (defining file, depth 1)  
3. callers  
4. file importers (defining file, depth 1)  
5. transitive dependents (caller-side depth `2..depth`; omit if `depth` is 1)

| mode | sections |
| --- | --- |
| `all` | 1–5 |
| `deps` | 1–2 |
| `dependents` | 3–5 |

## Agent output

Per [output-density.md](../cross/output-density.md) and relationship site density:

- Inside each section, group **by file** when multiple rows share a file.
- Rows: line/name/kind as needed, short exact preview when it helps jump/edit, depth when transitive.
- Certainty only when not `exact`.
- **No** locators, scores, test sections, test filters, or section tutorials ([stripped.md](../stripped.md)).
- Footers only for omissions/ambiguity/parser/budgets.
- Complete-block bounding + temp overflow ([bounded-output.md](../cross/bounded-output.md)).

## Errors / edge cases

- Ambiguous/missing target, bad scope, engine, cancel

## Non-goals

- Not `context`
- Not file-only deps without a symbol (`deps` / `reverse_deps`)
- Does not write files
