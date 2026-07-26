# Relationship tools

Shared contract for:

- `references`
- `callers`
- `callees`
- `implementations`
- `tests`

## Purpose

- Expand a declaration locator across a repository/subtree into related source sites.
- Always identify the nearest complete editable scope with a numeric locator.
- Be honest about exact vs inferred vs ambiguous resolution.
- Keep ambiguous results visible but non-actionable for blind edits.

## Parameters (all five tools)

- `path` (required string) — directory scope (repo/package/subtree)
- `locator` (required int ≥ 1) — numeric declaration locator from a prior structural tool
- `resultLimit` (required int 1…100)

## Common preconditions

- Scope path must be a directory.
- Locator must exist, be non-stale, and match current worker generation.
- Underlying declaration must still match its source fingerprint (worker rejects changed source).
- Declaration must lie inside the requested scope.

## Per-tool meaning

### `references`

- Direct references and type usages of the declaration.
- Includes re-export sites when classified as such.

### `callers`

- Syntactic call sites of the declaration.
- Inferred dispatch may be labeled; do not pretend stronger certainty than earned.

### `callees`

- Direct callees inside the target declaration’s executable/body scope.

### `implementations`

- Syntactic inheritance / implementation relationships and conservative same-name overrides where supported.
- Override-style results may be inferred and can be ambiguous when multiple candidates compete.

### `tests`

- Relationship sites classified as tests for the declaration (path heuristics and/or test-scope markers).

## Each relationship site must report

- Relative path + line/range
- Numeric locator for the enclosing editable scope (primary agent handle for follow-up `symbol`/edit)
- Relationship kind (reference, typeUsage, caller, callee, implementation, override, reExport, test)
- Certainty: `exact` | `inferred` | `ambiguous`
- Parse certainty for the site
- Classification: `production` | `test` | `generated` | `reExport`
- Site preview of the relevant source line/snippet (truncated if needed)
- Target declaration locator/path identity
- Candidate locators/paths when ambiguous (bounded list; omitted competitor count if truncated)
- Whether the site is actionable (ambiguous ⇒ not actionable)
- Certainty/uncertainty reasons when relevant

## Output rules

- No matches → explicit empty message for that operation.
- Exception footers only for omitted results, ambiguity counts when noteworthy, parser/diagnostic exceptions, or budgets hit.
- Complete-block bounding + temp overflow.
- Locators introduced for non-visible overflow units are dropped; the original query locator remains.

## Read gate / orientation

- Record structural attempts for relationship location files and enclosing-scope files (`relationshipLocation` / `relationshipScope`) and target fingerprints as applicable.

## Errors / edge cases

- Unknown/stale locator
- Non-directory scope
- Declaration outside scope
- Source changed since locator issue
- Non-declaration locator kinds rejected
- Worker unavailable
- Cancellation

## Non-goals

- Not a full precise IDE type-checker across all languages
- Must not silently “pick one” under ambiguity for edit safety
- Does not write files (rename impact planning is a separate edit tool)
