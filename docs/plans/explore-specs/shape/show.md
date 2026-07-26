# `show`

## Purpose

- Path+name → selective source view ([identity.md](../cross/identity.md)).
- Replaces locator `symbol` ([stripped.md](../stripped.md)).

## Parameters

- `targets` (required, min 1): `{ path, name, line? }[]`
- `view` (required): `signature` | `signatureWithDocs` | `declaration` | `declarationWithImports`
- `contextLines` (optional int ≥ 0) — only with `view=declaration`

## Behavior

- Resolve per [identity.md](../cross/identity.md).
- Dedupe identical targets.
- Single target ambiguous → candidate list only (no body guess).
- Multi-target batch: any missing/ambiguous → whole call errors with that target’s candidates; no partial bodies.
- Zero matches → error naming target.

## Agent output

Per [output-density.md](../cross/output-density.md):

- Exact source for the requested view — **no paraphrase**.
- Each block: path, line range, name, then text. Multi-path batches need path headers; single-path may omit redundant path chrome.
- Warnings only when real (e.g. no docs found for `signatureWithDocs`).
- **No** locators, scores, or view tutorials.
- Over budget → hard error, request fewer targets ([bounded-output.md](../cross/bounded-output.md)). No silent truncation of declaration batches.

## Errors / edge cases

- `contextLines` on non-declaration view → error
- Bad file/language, worker, schema

## Non-goals

- Not repo search; not edit; not locators
