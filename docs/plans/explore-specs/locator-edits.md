# Locator edit tools

Tools:

- `replace_declaration`
- `replace_body`
- `insert_declaration`
- `rename_declaration`

## Shared purpose

- Edit code through stale-safe numeric declaration locators.
- Validate structure before writing.
- Apply exact planned byte edits.
- Invalidate old locators for changed files.
- Emit standard Tau file-mutation events.
- Return fresh locators after clean reparse verification when possible.

## Shared execution rules

- Execution mode: sequential (no parallel races with other mutating tools in the same turn machinery).
- Locator must be known, non-stale, current worker generation.
- Reject parser-recovered / non-certain targets where the product requires certainty for safe edits.
- Plan first (no write on plan failure).
- Apply only exact source mutations from the plan with expected fingerprints.
- If no files changed → hard failure with reasons.
- Mark all locators for changed paths stale.
- Publish mutation event with paths, kinds, line stats, resulting fingerprints when available.
- Reparse changed files; verify fingerprints and parser health.
- Register fresh locators only for verified certain declarations from the plan’s fresh locator set.
- Result summarizes: changed paths, invalidated IDs, fresh IDs, skipped impacts, status, verification warnings.
- Do not dump whole new file contents as the primary success payload.

## `replace_declaration`

### Params

- `locator` (int ≥ 1)
- `source` (non-empty string) — one complete replacement declaration, or Markdown heading section

### Rules

- Replacement must parse as one declaration in the current parent container.
- **Markdown:** replaces the heading and its entire section, including deeper subsections.
- **Markdown:** replacement must contain exactly one root heading at the selected depth; only deeper child headings allowed beneath it.
- Nested replacement headings must stay below the selected heading depth.

## `replace_body`

### Params

- `locator` (int ≥ 1)
- `body` (non-empty string) — replacement for the adapter-provided body/section content

### Rules

- Replaces only the reliable body range; preserves signature and attached metadata outside that range.
- Requires a reliable non-empty body range.
- **Markdown:** preserves the heading line(s); replaces section content only.
- **Markdown:** body may contain only headings deeper than the selected heading.

## `insert_declaration`

### Params

- `locator` (int ≥ 1)
- `position` — `before` | `after`
- `source` (non-empty string) — exactly one declaration to insert

### Rules

- Inserts immediately before/after the target declaration in its parent container.
- Inserted source must parse as exactly one certain declaration in that container after insertion.
- **Markdown:** insertion is unavailable (error).

## `rename_declaration`

### Params

- `locator` (int ≥ 1)
- `newName` (non-empty string) — identifier in the target language
- `scope`:
  - `{ kind: "file" }` — current file only
  - `{ kind: "repository", path: string }` — explicit repo/subtree directory scope
- `includeInferred` (boolean) — whether inferred references may be updated

### Rules

- Renames the declaration and exact references within scope.
- Inferred references update only when `includeInferred=true`.
- Ambiguous references are never auto-changed; reported as skipped impacts.
- Uncertain parse sites skipped as needed.
- Skipped impacts include path/range/reason and candidate locators when available.
- **Markdown:** rename unavailable (error).
- Code rename requires the explicit file or repository scope object (no implicit whole-world rename).

## Skipped impact reasons

- `ambiguous`
- `uncertainParse`
- `inferredNotApproved`

## Verification warnings (examples)

- Post-mutation fingerprint mismatch vs plan
- Parser ERROR/MISSING nodes after edit
- Reparse failure

## Read gate / orientation

- Mutations invalidate orientation for changed paths via mutation bus.
- Patch fingerprints from successful applies can enable post-patch complete-file diff/unchanged reads ([read-gate.md](read-gate.md)).

## Errors / edge cases

- Stale/unknown locator
- Markdown unsupported operation
- Body range missing
- Replacement/insert not one certain declaration/section
- Apply failures / partial failure status surfaced honestly
- Worker unavailable

## Non-goals

- Not a general multi-hunk patch tool (use patch tooling when edits cross structural boundaries)
- Not format-on-write / prettier integration unless separately specified
