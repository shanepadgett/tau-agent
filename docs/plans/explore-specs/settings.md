# Explore settings

## Extension key

- `explore`

## `readGate`

- `includeGlobs` (string[], default `["**/*"]`)  
  Working-directory-relative paths to supported source that require a structural attempt before `read`.
- `excludeGlobs` (string[], default Markdown globs)  
  Paths excluded from the gate. Exclusions win over includes.
- Default excludes: `**/*.md`, `**/*.markdown`, `**/*.mdown`

## Matching rules

- Match is cwd-relative project path via Explore glob matching.
- Gate evaluation also requires the path’s language to be worker-supported ([read-gate.md](read-gate.md)).

## Lifecycle

- Settings load on session start (and follow Tau extension settings load rules).
