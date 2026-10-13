# Code

Lint, the type checker and the formatter already reject the mechanical problems (naming shape, spacing, `any`, parameter counts, comment narration). These rules cover what they cannot see: design and judgment. The goal is code a reader who has never seen the task can follow top to bottom.

## Design

- Solve the cause, not the symptom. If the code resists your change (a new flag, a copied block, a special case for one input), restructure it first, then add the change.
- Reuse before writing. Search `src/` and `docs/reference/copies/index.md` for an existing function, type or constant. Extend one that is close; write a new one only when none fits.
- Put code beside the concept it serves. A function about sessions lives with sessions, not in a shared grab-bag.
- Make modules deep: a small interface that hides real work. Delete a function, service or layer that only forwards to another. Do not split code into pieces that must be read together to make sense.
- Build for the use in front of you. No parameter, option, hook or abstraction for a caller that does not exist. Generalize on the second real use.
- No defensive code for states the types already rule out. Validate untrusted input once, at the boundary; inside, trust the types.
- No compatibility shims, fallback paths or "just in case" branches. Change the callers instead.
- Leave no dead code: no unused parameter, empty method or placeholder.

## Naming

- Name things by what they mean in the domain, not their type or mechanism: `pendingToolCalls`, not `list`. Avoid `info`, `item`, `handle`, `process`, `manager` and `do` prefixes.
- Use one word per concept. Search how the repo already names it before choosing a name.
- A function name is a verb that states the outcome. A boolean reads as a question: `isIdle`, `hasCredentials`.
- When a condition has more than two clauses, bind it to a named constant that says what it means.
- Put the unit in the name when the type does not carry it. Prefer `Duration` over a bare number.

## Functions and flow

- A function does one thing at one level of detail. The top of the function reads as a summary of the steps.
- Extract a block when its name explains why it exists, not to shorten the function.
- Handle failures and edge cases first and return. Keep the main path at the lowest indent.
- Do not mutate arguments or shared state. Return a new value.
- Use plain functions and plain data for pure logic. Use Effect when there is failure, async work, a resource or a dependency.
- Keep a file to one concept. Split it when you would need a heading to separate its parts.

## Types and data

- Model states that exclude each other as a tagged union, not optional fields or flags that are valid only in some combinations. `{ status: "failed", error }` and `{ status: "done", output }`, not `{ status, error?, output? }`.
- Parse external input into domain types at the edge. Give easily confused values (ids, paths) distinct types.
- Let inference work for locals. Write out types at module boundaries.

## Effect

Read the Effect reference before writing Effect code. These rules cover how we use it.

- A service owns one capability behind a small interface. Make a service for something with dependencies or state, or that a test replaces. A pure function is not a service.
- Service methods require nothing. Their dependencies come from the layer that builds the service.
- Only `cli` provides layers in `src/`. Other layers declare what they need and leave the wiring to it.
- Write sequences in `Effect.gen` or `Effect.fn`. Use `pipe` for short one-way transforms and to attach behavior such as retry, timeout or a span. Do not nest `pipe` chains.
- Expected failures are named domain errors in the error channel (`SessionNotFound`) that carry what the caller needs to act. Bugs are defects. Handle an error where something can be done about it; otherwise let it pass.
- Parse unknown data with `Schema`. Do not hand-write type guards; use `Predicate`.
- Anything a test must control (time, randomness, ids, the file system) comes from a service, not a global.
- Acquire resources with a scope so release is guaranteed. Never release by hand.

## Comments and messages

- Start every file in `src/` with a doc comment of one or two plain sentences saying what the file is for and when to use it, such as "Opens SQLite files and runs write transactions that hold the lock across async work." Do not list its contents.
- Comment why: a constraint, a tradeoff, a surprise, or an approach that failed. If a comment says what the code does, rename or extract instead.
- Describe the code as it is now. No history ("previously", "now uses", "changed to").
- Document an exported symbol only when its name and signature leave out something a caller needs: a guarantee, a failure, a unit.
- An error message says what failed, names the value involved, and says what to do next. Text for the user is plain language.
- Write comments and messages in simple technical English, as ASD-STE100 describes: short sentences, common words with one meaning each, and the active voice.

## Before you finish

Reread your diff as a reviewer who has not seen the task. Remove what you added "in case". For each new name, check it against its neighbours. For each new helper, check that nothing already does the job.
