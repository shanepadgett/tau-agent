# Read gate (structural attempt before read)

## Goal

- For configured supported source files, prevent agents from raw-reading file contents until they have made a current structural attempt on that exact file content fingerprint.
- Keep ordinary read available for unsupported files, ungated paths, images/binary fallbacks, and worker-unavailable cases.

## When the gate applies

- Gate applies only if all are true:
  - path is a supported structural language for the current worker language set
  - path matches Explore `readGate.includeGlobs` relative to cwd
  - path does **not** match `readGate.excludeGlobs` (exclusions win)
- Default settings:
  - include: `**/*`
  - exclude: `**/*.md`, `**/*.markdown`, `**/*.mdown` (Markdown ungated by default)
- If the worker cannot advertise languages / path is unsupported: gate does not apply (`ungated`).

## What counts as a structural attempt

A successful structural result that ties the file’s current content fingerprint to one of:

- `directOutline` — file appeared in an outline result (including recursive outline file units that remain visible/retained)
- `symbol` — file retrieved via `symbol`
- `apiCandidate` — file appeared as an `api_discover` candidate
- `structuralMatch` — file matched via `ast_search` (including completed zero-match direct-file search that reports the file fingerprint)
- `relationshipLocation` / `relationshipScope` — file appeared in relationship results (location and/or enclosing scope)

## Fingerprint currency

- Attempts are valid only for the exact content fingerprint recorded with the attempt.
- If the file bytes change, the old attempt no longer unlocks `read`.
- Stale attempt/fallback entries for other fingerprints are dropped on check.

## Fatal fallback

- Certain fatal outline failures that include a source fingerprint may record `fatalFallback` for that fingerprint.
- `fatalFallback` permits `read` for that fingerprint so the agent can inspect source after structural failure.
- Fallback is fingerprint-specific and cleared/replaced by a later successful attempt.

## Post-patch exception

- After a successful Tau file mutation with a resulting fingerprint, a complete-file cached `unchanged` or `diff` read may be permitted without a new structural attempt when:
  - the read is a complete-file request (no offset/limit partial range)
  - complete-file baseline text is still available
  - not in recovery mode
  - orientation still holds the patch fingerprint matching current file bytes
- This permission is `postPatchDiff`.
- If baseline is gone (compaction, cold resume, snapshot epoch reset), this exception does not apply; `read` may return full current source only after a normal unlock path or ungated path rules.

## Blocked read behavior

- Blocked reads throw a clear error naming the path.
- Error tells the agent to use structural tools first (exact-name outline, focused api_discover, file-scoped ast_search, or symbol with a fresh locator), then retry `read`.
- Blocked attempts are counted for telemetry/read-stats.

## Invalidation

- File mutations invalidate structural readiness for changed paths as needed (attempts no longer match new bytes; locators go stale separately).
- Orientation gate reset occurs on session tree reset / clear paths defined by session lifecycle.

## Non-goals

- Gate is not a general permissions system for secrets.
- Gate does not block `ls` / `find` / `grep`.
- Gate does not require structural attempts for excluded globs or unsupported types.
