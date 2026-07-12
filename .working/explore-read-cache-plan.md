# Explore Read Cache Plan

## Goal

Make repeated `read` calls consume less model context while preserving the current tool contract and never hiding changed content.

The cache represents content the agent has already seen on its active session branch. It is not a filesystem cache and must never use an untrusted hash to suppress output.

## Read behavior

A normalized request identity contains:

- canonical path
- effective line range
- `lineNumbers`
- the range actually served after output truncation

The tool follows these rules:

1. The first request returns the current baseline output.
2. Repeating the same request when the complete file hash is unchanged returns a compact unchanged marker.
3. If the file changed anywhere, a range request returns the requested range normally.
4. A changed full-file request returns a bounded unified diff when a trusted base snapshot is available and the diff is useful.
5. A changed full-file request returns normal output when no safe, useful diff is available.
6. A different range or `lineNumbers` presentation returns normal output and establishes trust for that request.
7. Images, unsupported content, errors, and aborts retain baseline behavior.
8. A failed or partially failed patch unlocks one normal content-bearing read for each failed path. An unrelated read does not consume that unlock.

There is no “requested range unchanged, changes exist elsewhere” result. When the file hash changed, a range read returns content.

## Hashing and resource limits

- Hash the `Buffer` already loaded by `readFile`; never perform a second read for hashing.
- Use Node's native SHA-256 implementation.
- Do not use a filesystem-metadata shortcut initially. Matching size and timestamps cannot prove matching content.
- Do not create a persistent snapshot store initially.
- Keep diff snapshots in a content-addressed, byte-bounded in-memory LRU.
- Initial internal limits:
  - maximum retained snapshot: 1 MiB
  - total snapshot cache: 16 MiB
- Oversized files can still use unchanged detection because the tool already loaded their bytes, but their content is not retained for future diffs.
- Evicted or unavailable snapshots cause baseline output.
- Clear process caches on session shutdown and keep replay memoization bounded.

This intentionally gives up changed-file diffs across process restarts. Session metadata still supports unchanged detection after resume. If the resumed file changed, the tool returns normal output and establishes a new in-memory diff base.

## Session trust metadata

Each eligible result receives private, versioned metadata under `details`:

```ts
interface ReadCacheMetaV1 {
 v: 1;
 pathKey: string;
 scopeKey: string;
 servedHash: string;
 baseHash?: string;
 mode: "baseline" | "recovery" | "unchanged" | "diff";
}
```

`scopeKey` describes the content actually shown, including the effective range and `lineNumbers` presentation.

The metadata lets Tau prove that the agent on the active branch saw a particular file version and scope. It is internal bookkeeping, not a new model-facing option.

## Trust reconstruction

- Reconstruct trust from valid `read` result metadata on the active session branch.
- Baseline output establishes trust for its exact scope.
- `unchanged` and `diff` results only advance trust when `baseHash` matches existing trusted state.
- The latest compaction is a hard trust boundary. The first matching read after compaction returns baseline output.
- Tree navigation, branch switches, forks, and resumes derive state from the selected branch.
- Use a small in-memory overlay for reads whose tool results have not yet reached persisted branch history.
- Clear replay memoization and overlays when session-tree events make their keys stale.
- Invalid, unknown, or incomplete metadata establishes no trust.

Snapshot availability never establishes trust. Snapshots only provide old text after branch history has supplied a trusted base hash.

## Diff policy

A full-file diff is returned only when all conditions hold:

- the request represents a full-file read
- the prior trusted hash has a snapshot in memory
- current and prior content are valid text
- the file is within the retained-snapshot limit
- diff generation succeeds
- the diff is smaller than baseline output
- the diff fits the existing output limits without truncation

Otherwise the tool returns baseline output.

Changed reads with `lineNumbers: true` return baseline output rather than mixing numbered source presentation with unified-diff formatting.

## UI design pending approval

The tool preview proposes result-owned rows:

- pending: `read path`
- baseline: `read path  <n> lines`
- unchanged: `read path  unchanged`
- diff: `read path  +<added> -<removed>`
- error: `read path  error`

Collapsed rows show the summary. Expanded rows show the summary and model payload. Internal fallback is not labeled; it looks like an ordinary baseline read because that is what the agent receives.

Approve or revise these previews before production renderer work begins.

## Expected implementation shape

Likely additions under `packages/agent/extensions/explore/`:

- `read-cache-meta.ts`: metadata validation and guarded trust transitions
- `read-cache-replay.ts`: branch reconstruction, bounded memoization, and same-turn overlay
- `read-cache-snapshots.ts`: byte-bounded content-addressed LRU
- `read-diff.ts`: bounded unified-diff generation

`read.ts` remains responsible for path handling, baseline compatibility, the read decision, and rendering integration. Explore extension registration wires cache invalidation to session lifecycle events.

No settings, refresh tool, range shorthand, persistent object store, or new public read parameters are included. `/read-stats` opens the approved token-and-cost savings overlay.

## Test coverage

- first read returns baseline output
- repeated identical request returns unchanged
- changed full read returns a useful bounded diff
- missing, oversized, truncated, or unhelpful diff returns baseline output
- changed range always returns requested content
- different ranges do not share range trust
- `lineNumbers` participates in request identity
- truncation records only the served scope
- branch trust does not leak across tree navigation
- first matching read after compaction returns baseline output
- malformed or unsupported metadata cannot establish trust
- absent LRU snapshot returns baseline output
- LRU obeys per-entry and total byte limits
- image behavior remains delegated
- aborts do not update trust or snapshots
- existing offsets, continuation notices, rendering, and errors remain compatible
