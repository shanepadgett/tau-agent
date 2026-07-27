# Explore

Explore gives Tau 12 structural source tools: outlines, declaration slices, discovery, structural search, graph and relationship queries, impact, and context packs. Targets use path + declaration name, with an optional line to disambiguate.

Pi keeps ordinary filesystem tools (`ls`, `find`, `grep`, `read`). Explore adds structure on top of supported source languages via in-process tree-sitter (WASM) on every platform supported by the Node runtime. Registered languages share the same tools and exploration workflow.

## Large `read` / autoread

When `explore.read.enabled` is on (default), a full Pi `read` or autoread of a registered source file (including Markdown) above `explore.read.structureThresholdLines` (default 200) returns an **outline** — declarations or headings — not the full body. Use ranged `read` (`offset`/`limit`) or `show` for bodies and sections. Small files and unregistered paths stay ordinary Pi full text. Set `explore.read.enabled` to `false` to turn the overlay off.

## Tools

- `outline` — declarations and structure for a file, one-level directory, or recursive subtree (no bodies).
- `show` — exact signature / docs / declaration / declaration+imports for path+name targets.
- `discover` — find reusable declarations across a repo/package/subtree by name, kind, or docs (signatures only).
- `deps` / `reverse_deps` — file import graph forward and reverse.
- `callers` / `callees` / `references` / `implementations` — symbol relationship sites.
- `impact` — blast radius: symbol callees/callers plus file imports/importers/transitive dependents.
- `context` — budgeted pack of bodies/signatures around one symbol.
- `ast_search` — structural pattern search (ast-grep) over supported source.
