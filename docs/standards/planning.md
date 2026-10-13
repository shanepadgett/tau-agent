# Planning

## All plans

- A plan fits in one to two pages and is mostly visual: diagrams, tables and trees, with prose only for a decision, a tradeoff or a question. If it runs longer, split the work or cut detail; nobody reads page three.
- Lead each section with the decision or the shape. Reasons come after, in short sentences.
- Lasting plans live in `docs/plan/`. The table in `docs/plan/README.md` says which file holds what.
- Record each agreed decision in the plan file in the same reply. A correction rewrites the affected part; do not append history.
- Search `docs/reference/copies/index.md` and the dependency's docs and types before proposing any helper, type, or dependency. Name the library module and function that provides each capability. Propose new code only after the reference shows nothing that fits, and name no API that you did not find there.
- Plan in rounds. Each round asks a small batch of related decisions.
- Unanswered questions go in `docs/plan/questions.md`.

## Reader

Assume the reader is new to this codebase and may not read the code you write. Never assume they know an area.

- On first use, say in a few words what a system, file, term or earlier decision is and where it lives. Do not refer to something the reader has not been shown.
- Define any name coined during the session before using it, or use the plain description instead.
- State what the change means in plain words before how it works: what the user sees, or what the code can do afterwards that it could not before.

## Engineering health

A plan is accountable for the long-term health of the repository, not only for the feature.

- Start with what exists. Read the code the feature touches and show how it works today, in a diagram or table, before proposing anything.
- Ask what shape would make this feature slot in cleanly. If the current structure resists it, plan the structural change as a prep step, listed apart from the feature with the reason. Do not defer debt the feature creates or exposes.
- Defer only unrelated improvements, and record each in `docs/plan/deferred.md` instead of leaving it in the plan.
- Reuse before adding. For each new piece, name the existing code or library it reuses, or say where you looked and why nothing fit.
- Name what the change deletes or replaces. A plan that only adds code is incomplete.
- Weigh at least two shapes for any new paradigm or abstraction, and say what each costs to maintain.

## Architecture plans

For which systems exist, how they meet, and which abstractions and patterns fit.

- Name each system involved and whether the work adds, changes, or expands it.
- Show boundaries and dependencies as a Mermaid diagram: one idea per diagram, 5–9 boxes, short labels, left to right. Split a diagram rather than grow it.
- Name the pattern chosen (state machine, events, middleware, wrapped services) and the alternative it beat, with one line of tradeoff.
- When work would add another flag or special case to a growing set of states, propose a structure instead.
- Research architectural concepts, not only libraries: name the paradigms that could fit, how other systems apply them, and what each costs to evolve. Cite the systems studied.
- Stop at interfaces. No implementation code.

## Code-level plans

Show, don't tell. Prose is limited to tradeoffs and open questions, one line each.

- File layout as a tree, with a one-line purpose for each new or changed file.
- Types at each boundary as TypeScript signatures.
- The call path from entry point to leaves as a Mermaid sequence diagram or flowchart.
- Logic as pseudocode: one action per line, names from the domain, indentation for nesting, no language noise.
- Show where behavior is injected. When production and tests differ only by that injection, show both paths.
- `docs/plan/deferred.md` lists decisions to make later, one line each: the question and what brings it up. When that happens, move the item to `questions.md`.
- Code-level plans live in `docs/plan/work/`, one file per piece of work. When a round is built, checks pass and any live check the user asked for has passed, move each decision that still matters into a lasting plan file, delete the round's plan, and fix links to it. Do this before planning the next round.
