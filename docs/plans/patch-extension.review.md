# patch extension review

Scope: src/extensions/patch five files (~1250 lines). Simplify, no behavior change.

## High impact

- executor ChunkApplyFailure wraps UpdateChunkApplyError and copies its fields; the only extra (re-derive contextHint) resolves to the same value. Delete class, drop formatContextHint import, catch UpdateChunkApplyError directly.
- executor over-instrumented abort checks (~13 throwIfAborted, 3 in readUtf8). Keep strategic ones: entry, post-parse, pre-commit, per-op commit.
- ApplyPatchSummary: added/updated/deleted/moved/linesAdded/linesRemoved/completedOperations all derive from changes. completedOperations is literally changes.length. Drop flat arrays, derive in consumers; removes recordChange.
- executor snapshot() deep-copies every array per tick because summary is mutated in place. Build immutable progress per tick.

## Thin single-use helpers (inline)

- matcher buildOldLines, serializeLines (1 call each).
- matcher splitLogicalLines double-normalizes (splitText already normalized parts.text).
- render touchedFileCount (1 line 1 call), indicator (1 call).
- executor recordChange (vanishes with summary de-denorm).

## parser

- Duplicated "only first chunk may omit anchor" guard: EOF branch and general fallback near-identical. Collapse to one lazy init of current.
- parseHeaderMetadata re-parses prefix grammar that parseSection already matched. Goes away if section parse returned kind/path on failure instead of throwing.

## render grammar duplication

- scanPreview (~50 lines) is a second tolerant parser for the same grammar. Justified for streaming partial input but two owners of grammar (Replace accepted in both but undocumented). Add shared header matcher or locked-prefix comment.

## Minor

- executor totalOperations = totalSections alias; use totalSections.
- matcher TextParts BOM/CRLF round-trip is legit; consolidate helpers but keep round-trip.

No correctness blockers. All changes behavior-preserving.
