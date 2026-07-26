# Explore behavior specs

Durable product/behavior contracts for Explore tools and cross-cutting rules.

## Intent

- Specs describe **what the system must accomplish**, not how to implement it.
- No architecture, module layout, class design, or rewrite plan here.
- Another design pass can invent structure; these files judge whether that structure still does the job.

## Sources

Derived from current Explore user docs and implemented tool contracts. Where docs and code disagree, these specs should be corrected to the intended product rule, then code/docs brought in line.

## Index

### Cross-cutting

- [system.md](system.md) — purpose, languages, platform, session lifecycle
- [settings.md](settings.md) — extension settings
- [read-gate.md](read-gate.md) — structural attempt requirement before `read`
- [locators.md](locators.md) — numeric locator identity and staleness
- [bounded-output.md](bounded-output.md) — model-visible limits and temporary overflow
- [path-conventions.md](path-conventions.md) — path inputs, ignore rules, display

### Filesystem tools

- [ls.md](ls.md)
- [find.md](find.md)
- [grep.md](grep.md)
- [read.md](read.md)

### Structural tools

- [outline.md](outline.md)
- [symbol.md](symbol.md)
- [api-discover.md](api-discover.md)
- [ast-search.md](ast-search.md)
- [relationships.md](relationships.md) — references, callers, callees, implementations, tests

### Edit tools

- [locator-edits.md](locator-edits.md) — replace_declaration, replace_body, insert_declaration, rename_declaration

### Session extras

- [guidance.md](guidance.md) — pre-turn AST-first system guidance
- [read-stats.md](read-stats.md) — `/read-stats` command
- [autoread.md](autoread.md) — complete-file knowledge injection

## How to use

1. Changing tool behavior? Update the matching spec in the same change.
2. Designing a rewrite? Treat these as acceptance criteria.
3. Ambiguity in a bullet? Prefer the stricter safety/honesty rule until product decides otherwise.
