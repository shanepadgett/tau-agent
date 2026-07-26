# `symbol`

## Purpose

- Resolve one or more numeric locators to selective source views.
- Batch multiple locators in one call.
- Fail the whole batch if any locator is invalid/stale.

## Parameters

- `locators` (required int[], min 1, each ≥ 1) — numeric IDs from outline/api_discover/search/relationships
- `view` (required enum):
  - `signature` — signature only; no docs, no body
  - `signatureWithDocs` — signature plus attached documentation; no body
  - `declaration` — exact declaration/section source
  - `declarationWithImports` — declaration plus required imports
- `contextLines` (optional int ≥ 0) — extra surrounding source lines; **only allowed with `view=declaration`**

## Behavior

- Deduplicate locator IDs before resolution.
- Map numeric IDs to native declaration tokens; request unique tokens from the worker.
- Validate every locator before calling the worker (unknown/stale/worker-generation mismatch → error).
- Return one or more source blocks; multi-path batches include path headers; single-path batches may omit redundant path headers.
- Each block shows line range, contributing numeric IDs, names, diagnostics, then source text.
- Native association diagnostics surface as warnings tied to locator IDs (example: no attached documentation identified).
- If output would exceed model limits → hard error: request fewer locators (no silent truncation).
- `view=declaration` marks those locators as declaration-retrieved for any downstream policy that cares.

## Read gate / orientation

- Successful symbol retrieval records structural attempts (`symbol`) for returned declaration files/fingerprints.

## Errors / edge cases

- `contextLines` with non-declaration view → error
- Unknown locator → error, no worker call
- Stale locator → error, no worker call
- Worker restart since issue → stale error
- Empty/invalid batch inputs rejected by schema

## Non-goals

- Does not search the repo
- Does not edit code
- Does not invent locators
