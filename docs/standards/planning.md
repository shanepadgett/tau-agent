# Planning

## All plans

- A plan fits in one to two pages. If it runs longer, split the work or cut detail; nobody reads page three.
- Lead each section with the decision or the shape. Reasons come after, in short sentences.
- Lasting plans live in `docs/plan/`. The table in `docs/plan/README.md` says which file holds what.
- Record each agreed decision in the plan file in the same reply. A correction rewrites the affected part; do not append history.
- Search `docs/reference/copies/index.md` and the dependency's docs and types before proposing any helper, type, or dependency. Name the library module and function that provides each capability. Propose new code only after the reference shows nothing that fits, and name no API that you did not find there.
- Plan in rounds. Each round asks a small batch of related decisions.
- Unanswered questions go in Open in `docs/plan/README.md` and are re-asked each reply until answered. Remove or reword them when another answer settles or changes them.

## Architecture plans

For which systems exist, how they meet, and which abstractions and patterns fit.

- Name each system involved and whether the work adds, changes, or expands it.
- Show boundaries and dependencies as a Mermaid diagram: one idea per diagram, 5–9 boxes, short labels, left to right. Split a diagram rather than grow it.
- Name the pattern chosen (state machine, events, middleware, wrapped services) and the alternative it beat, with one line of tradeoff.
- When work would add another flag or special case to a growing set of states, propose a structure instead.
- Stop at interfaces. No implementation code.

## Code-level plans

Show, don't tell. Prose is limited to tradeoffs and open questions, one line each.

- File layout as a tree, with a one-line purpose for each new or changed file.
- Types at each boundary as TypeScript signatures.
- The call path from entry point to leaves as a Mermaid sequence diagram or flowchart.
- Logic as pseudocode: one action per line, names from the domain, indentation for nesting, no language noise.
- Show where behavior is injected. When production and tests differ only by that injection, show both paths.
- `docs/plan/deferred.md` lists decisions to make later, one line each: the question and what brings it up. When that happens, move the item to Open in README.md.
- Code-level plans live in `docs/plan/work/`, one file per piece of work, and are deleted once the work ships.
