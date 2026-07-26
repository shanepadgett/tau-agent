# `outline`

## Purpose

- Inspect declarations (and structural file rows) without returning implementation bodies.
- Issue numeric locators for retrievable declarations/members/headings.
- Support single file, one-level package directory, or recursive mixed-language subtree orientation.

## Parameters

- `path` (required string) — supported source file or directory
- `includePrivate` (optional boolean) — include non-public declarations/members; default false
- `includeDocs` (optional boolean) — include attached documentation comments in signatures; default false
- `names` (optional string[], min 1) — exact top-level or member declaration name filter
- `recursive` (optional boolean) — recursively outline every supported source file under a directory

## Target modes

### File

- Path must be a supported language file (after symlink canonicalization).
- Unsupported file type → error.

### Directory (non-recursive)

- One-level package/directory outline of supported files in that directory scope (worker directory target semantics).
- Empty / no matches:
  - with `names` → “No matching declarations”
  - without `names` → “No declarations”

### Recursive directory

- `recursive: true` requires a directory path; otherwise error.
- Ignore-aware mixed-language walk under budgets ([path-conventions.md](path-conventions.md)).
- Stream/emit per-file outline units.
- Model output uses complete-block bounding; oversized complete outline saved to temp when possible ([bounded-output.md](bounded-output.md)).
- Diagnostics for failed/unreadable/oversized/parser issues appear as diagnostic units.
- Exception/limit footers only when something failed or a budget was hit (not cheerful full success summaries).

## Output expectations

- Show declaration signatures and structure, not function/method bodies.
- Annotations/attributes remain visible in normal outlines.
- Parenthesized numeric locators after line ranges for retrievable declarations.
- Structural rows (package/import/export/side-effect) may appear in source order without locators.
- Multi-file outputs attribute paths; single-file outputs need not repeat path chrome when unnecessary.
- Parser recovery warnings when ERROR/MISSING node counts are non-zero.
- Certainty warnings when a declaration is not `certain`.
- Markdown headings outline as headings; locator covers the full section.

## Language coverage

- All supported structural languages listed in [system.md](system.md).

## Read gate / orientation side effects

- Successful file outlines record structural attempts (`directOutline`) for each outlined file fingerprint retained.
- Typed fatal outline failures with fingerprints may record fatal fallback for `read`.
- Recursive partial visibility still records attempts for files that were structurally processed per orientation rules; locator retention follows overflow visibility rules.

## Errors / edge cases

- Unsupported file type
- Recursive on non-directory
- Worker unavailable / platform unsupported
- Cancellation aborts recursive streams and does not leave partial temp output as success
- Symlinked supported files resolve to canonical target language

## Non-goals

- Not a full source dump
- Not reference/search
- Does not write files
