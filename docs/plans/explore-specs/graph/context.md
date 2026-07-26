# `context`

## Purpose

- Budgeted pack to understand one symbol in one call.

## Parameters

- `path` (required string) — directory scope
- Target identity per [identity.md](../cross/identity.md): `targetPath?`, `name`, `line?`
- `budget` (optional int ≥ 1) — default from [settings.md](../cross/settings.md) `context.defaultBudgetTokens` (**8000**)

## Target resolution

- Exactly one declaration or candidates-only stop.
- Callable and type targets.
- Graph/parse data from session cache ([system.md](../cross/system.md)); edges align with [relationships.md](relationships.md).

## Packing order

### Callable

1. Target body (else signature + `target_omitted`)
2. Direct callees — body while budget allows, else signature
3. Direct caller signatures
4. Depth-2 callee signatures
5. Depth-2 caller signatures

### Type

1. Type body (same omit rule)
2. Implementors — body then signature
3. Methods — body then signature
4. Dependents (callers of methods) — signatures

## Budget

- Estimate `ceil(bytes / 4)` until a better shared estimator exists.
- Never exceed pack `budget`. Entry: try body → signature → skip (`truncated`).
- Dedup symbol across sections.
- External/missing body → `body_unavailable` + best signature.
- Then shared bounded handler ([bounded-output.md](../cross/bounded-output.md)).

## Agent output

Per [output-density.md](../cross/output-density.md):

- Header: target, `budget`, `used`.
- Labeled groups; each entry path/line/kind + **exact** body or signature + per-entry token estimate only if useful to retry larger budget (keep short).
- Flags when set: `truncated`, `target_omitted`, `body_unavailable`.
- **No** locators, scores, or packing tutorials.
- Do not tree-compress source text inside entries.

## Errors / edge cases

- Ambiguous/missing target, bad scope, `budget` < 1, worker, cancel

## Non-goals

- Not `impact`; not autoread default; no writes
