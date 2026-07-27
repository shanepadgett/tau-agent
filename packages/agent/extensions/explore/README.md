# Explore

Structural source tools for Tau: outlines, declaration slices, discovery, graph and relationship queries, impact, and context packs.

Pi keeps ordinary filesystem tools (`ls`, `find`, `grep`, `read`). Explore adds structure on top of supported source languages via in-process tree-sitter (WASM).

## Large `read` / autoread

When `explore.read.enabled` is on (default), a full Pi `read` or autoread of a registered source file (including Markdown) above `explore.read.structureThresholdLines` (default 200) returns an **outline** — declarations or headings — not the full body. Use ranged `read` (`offset`/`limit`, capped by `explore.read.maxRangeLines`) or `show` for bodies and sections. Small files and unregistered paths stay ordinary Pi full text. Set `explore.read.enabled` to `false` to turn the overlay off.

## Adding a language

Two required code edits: one adapter under `ast/languages/`, one line in `ast/registry.ts`. Grammar languages also pin a WASM artifact under `ast/grammars/`. Tools and shared queries stay language-agnostic — new languages do not touch them.

## Tools

- `outline` — declarations and structure for a file, one-level directory, or recursive subtree (no bodies).
- `show` — exact signature / docs / declaration / declaration+imports for path+name targets.
- `discover` — find reusable declarations across a repo/package/subtree by name, kind, or docs (signatures only).
- `deps` / `reverse_deps` — file import graph forward and reverse.
- `callers` / `callees` / `references` / `implementations` — symbol relationship sites.
- `impact` — blast radius: symbol callees/callers plus file imports/importers/transitive dependents.
- `context` — budgeted pack of bodies/signatures around one symbol.
- `ast_search` — structural pattern search (ast-grep) over supported source.
