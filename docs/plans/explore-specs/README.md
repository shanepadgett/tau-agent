# Explore behavior specs

Durable product/behavior contracts for Explore tools and cross-cutting rules.

## Intent

- Specs describe **what the system must accomplish**, not how to implement it.
- No architecture, module layout, class design, or rewrite plan here.
- Another design pass can invent structure; these files judge whether that structure still does the job.
- **Easy language extension is a product goal.** Tool contracts stay language-agnostic; new languages register through the worker adapter/IR path without new tools or new agent workflows ([system.md](cross/system.md)).

## Sources

Product decisions for the simplified Explore spine: path+name identity, structural `read`, composites `impact`/`context`, harness edits only. No session locators. No locator edits. No `tests` tool. No read-stats. Language set is worker-registered and growable, not a per-tool closed world.

## Stripped from current system

**Normative delete list:** [stripped.md](stripped.md).

Anything there does **not** carry forward — including numeric locators, locator edits, read-gate/orientation unlock machinery, `symbol` / `api_discover` / `tests`, and the entire `/read-stats` command + savings/telemetry machinery. Rewrite work must not preserve those paths for compatibility.

## Layout

```text
explore-specs/
  README.md
  stripped.md
  cross/      # contracts every tool obeys
  fs/         # Pi-shaped filesystem tools
  shape/      # outline / show / discover / ast_search
  graph/      # deps + relationships + impact / context
  session/    # guidance + autoread
```

## Index

### Root

- [stripped.md](stripped.md) — explicit non-carry-forward list from current Explore

### `cross/`

- [system.md](cross/system.md) — purpose, languages, platform, session lifecycle
- [settings.md](cross/settings.md) — extension settings
- [identity.md](cross/identity.md) — path+name target binding (no session locators)
- [read-policy.md](cross/read-policy.md) — structural full-read / range rules for supported source
- [output-density.md](cross/output-density.md) — agent text: path factoring, exact snippets, no search meta
- [bounded-output.md](cross/bounded-output.md) — model-visible limits and temporary overflow
- [path-conventions.md](cross/path-conventions.md) — path inputs, ignore rules, display

### `fs/`

- [ls.md](fs/ls.md)
- [find.md](fs/find.md)
- [grep.md](fs/grep.md)
- [read.md](fs/read.md)

### `shape/`

- [outline.md](shape/outline.md)
- [show.md](shape/show.md)
- [discover.md](shape/discover.md)
- [ast-search.md](shape/ast-search.md)

### `graph/`

- [deps.md](graph/deps.md)
- [reverse-deps.md](graph/reverse-deps.md)
- [relationships.md](graph/relationships.md) — callers, callees, references, implementations
- [impact.md](graph/impact.md)
- [context.md](graph/context.md)

### `session/`

- [guidance.md](session/guidance.md) — pre-turn exploration system guidance
- [autoread.md](session/autoread.md) — complete-file / outline injection

## Final tool spine

`ls` `find` `grep` `read`  
`outline` `show` `discover` `ast_search`  
`deps` `reverse_deps`  
`callers` `callees` `references` `implementations`  
`impact` `context`

**16 tools.** File mutation stays on harness `patch` / `edit` / `write`. No Explore commands beyond ordinary tool use (no `/read-stats`).

## How to use

1. Changing tool behavior? Update the matching spec in the same change.
2. Designing a rewrite? Treat these specs as acceptance criteria and [stripped.md](stripped.md) as the delete list.
3. Ambiguity in a bullet? Prefer the stricter safety/honesty rule until product decides otherwise.
4. Old Explore behavior not listed under “Still in product” in stripped.md does not carry forward.
