# `api_discover`

## Purpose

- Discover reusable declarations across a repository/package/subtree when path or exact name is unknown.
- Return signatures without implementation bodies.
- Issue numeric locators accepted by `symbol`.
- Report caller access paths where resolvable (especially package surface).

## Parameters

- `path` (required string) — directory scope only (repo/package/subtree)
- `query` (required tagged union; exactly one kind):
  - `exactName` — `{ kind, name }`
  - `prefixName` — `{ kind, name }`
  - `substringName` — `{ kind, name }`
  - `fuzzyName` — `{ kind, name, maxCandidates, maxWork }`
    - `maxCandidates`: 1…10000
    - `maxWork`: 1…1000000
  - `declarationKind` — `{ kind, declarationKind }`
    - kinds include: module, namespace, package, class, method, property, field, constructor, enum, interface, function, variable, constant, object, enumMember, struct, event, operator, typeParameter, heading
  - `documentation` — `{ kind, terms[], maxCandidates, maxWork }`
- `surface` (required enum):
  - `all`
  - `public`
  - `private`
  - `sourceExport`
  - `packageSurface`
- `resultLimit` (required int 1…100)

## Behavior

- Directory scope required; file path → error.
- Scan under recursive traversal budgets.
- Each candidate includes at least:
  - defining file + line range
  - numeric locator
  - name and symbol type
  - signature (no body)
  - visibility / export / package-surface / internal-only status when known
  - provenance and parse certainty when not trivially exact/certain
  - uncertainty notes when present
- When caller access is known: canonical module path, exact import statement, access expression, form (direct/qualified).
- TypeScript/TSX may include re-export chains (defining file separate from import path).
- Languages covered: TypeScript, TSX, Odin, Go, Rust, C#, Java, Kotlin, Swift (and heading kind where applicable).
- No matches → explicit empty result message.
- Exception/limit footers only for omitted candidates, resolution diagnostics, or budgets hit.
- Output bounded with complete-block retention; overflow to temp when needed.
- Locators for non-visible overflow candidates are not retained.

## Read gate / orientation

- Each returned candidate records an `apiCandidate` structural attempt for its defining file fingerprint.

## Errors / edge cases

- Non-directory scope
- Worker unavailable
- Cancellation
- Fuzzy/docs work limits must be honored; hitting them is reported, not silent incomplete success

## Non-goals

- Not a substitute for `outline` of a known file
- Not reference finding
- Does not write files
