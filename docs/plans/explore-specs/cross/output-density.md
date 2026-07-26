# Output density (agent-facing)

## Goal

- Model-visible tool text carries **only what the agent needs** to navigate, decide, and edit.
- Prefer hierarchical path factoring over repeating full paths.
- Prefer exact source snippets where an edit or precise jump depends on them.
- Strip search/engine meta that does not change the next action.

## Audience

- These rules apply to **agent/model text** (tool result payloads the model sees).
- Human TUI chrome may be richer. Do not force human-only meta into the model string.

## Must include (when applicable)

- Paths the agent will pass to a later tool (`read`, `show`, patch, graph, …), cwd-relative when possible
- Line or line-range anchors for hits and declarations
- Names, kinds, signatures needed to choose among candidates
- **Exact** match/declaration/snippet text when the agent may edit against it or must see real code
- Certainty when not plain `exact` (`inferred` / `ambiguous`) — affects whether blind edit is safe
- Ambiguity candidate lists (path + name + line + short signature)
- Honest omission/limit/budget notices when results were cut
- Empty-result statements (so the agent does not retry forever guessing)

## Must not include (agent text)

- Numeric session locators (none exist)
- Ranking scores, BM25/dense weights, internal priority, “relevance” percentages
- Engine/work counters (`maxWork` consumed, candidate heap size, timing, cache hit/miss) unless a **budget was hit** and the agent must tighten the query
- Redundant restatement of the tool’s own args (“searching for X in Y with limit Z”) as a preamble
- Per-hit essays: provenance monologues, certainty **reasons** when the label alone is enough; keep reasons only when ambiguity or non-exact needs a short clause
- File “line count” / size headers on every group unless the agent asked for long/metadata mode
- Duplicate full paths on every child row when a file/directory header already fixed the stem
- Success cheerleading, section docs, or “how to use this tool” tutorials inside results
- Human-oriented dual rendering notes, schema names, or implementation breadcrumbs

## Path factoring (required where lists share paths)

| Result shape | Factoring |
| --- | --- |
| Path inventories (`ls`, `find`) | **Directory tree**: indent children; do not reprint the full path on every entry |
| Content hits (`grep`, `ast_search`) | **Per-file groups**: path once, then line-anchored rows under it |
| Multi-file outlines / discover hits / graph sites / impact entries | **Per-file groups** (or per-file outline units): path header, then rows |
| Single-target `show` / ranged `read` / `context` entry bodies | **No** tree compression of the source text itself — exact bytes/lines |

Within a file group, child rows use line numbers (and columns if essential), not repeated `path:line` prefixes, unless a row jumps to another file.

## Exactness vs compression

- **Compress chrome** (paths, headers, repeated labels).
- **Do not compress or paraphrase** source that may back an edit: grep lines, ast-search previews, `show` declarations, `read` slices, `context` bodies.
- Snippet truncation only under explicit size pressure, with a clear truncated mark — never silent rewrite.

## Footers

- Footers exist only for: omissions due to limits, hard budget hits, parser/diagnostics that affect trust, ambiguity summaries when not inline.
- No footer on clean full success.

## Relation to other specs

- Density is how rows are shaped **before** and **inside** budget handling.
- [bounded-output.md](bounded-output.md) still caps total model-visible size and may temp-overflow complete results.
- Path display roots in [path-conventions.md](path-conventions.md).
- No session locators in any payload ([identity.md](identity.md), [stripped.md](../stripped.md)).
- Applies to every agent-facing Explore tool result, including [ls.md](../fs/ls.md), [find.md](../fs/find.md), [grep.md](../fs/grep.md), [read.md](../fs/read.md), shape/graph/composite tools, and [autoread.md](../session/autoread.md) injections.
