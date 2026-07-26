# Phase 3: First-Outline Read Gate

Status: implementation unapproved  
Depends on: Phase 2 complete-file visibility metadata  
Produces: a fingerprinted AST-first gate on Tau's official `read` tool

## Current state

Explore overrides Pi's `read` tool. The implementation resolves paths against `ctx.cwd`, reads bytes, delegates images and invalid UTF-8 to Pi's base read tool, tracks complete-file baselines, and can return diffs or unchanged markers on later reads. Explore also owns read snapshots and `/read-stats`.

Tau's AST tools already use source fingerprints for stale locators. `tau:file-mutation.applied` reports changed paths after `patch`, allowing immediate invalidation. External edits still require fingerprint or filesystem freshness checks on access.

Explore does not currently record which supported files were structurally shown to the model. The gate must add that state without breaking existing read-cache behavior.

## Decisions required before coding

Resolve and record:

1. The exact worker diagnostic or typed error that means an outline attempt could not produce any usable model-visible file result and therefore creates a read fallback.
2. Whether orientation records survive context compaction. Session continuity favors retaining them; conservative behavior favors clearing them.

The fallback must be tied to canonical path and current source fingerprint. Ordinary recovery warnings do not create it because a rendered degraded outline already satisfies orientation.

## Orientation state

Track, per canonical path:

- source fingerprint;
- whether a complete file block was visible to the model;
- outline `includePrivate` value and exact-name filters for telemetry only;
- parser diagnostics and whether the worker produced a usable result;
- retrieved locator IDs and symbol views;
- blocked and permitted read attempts; and
- source bytes deflected from model context.

Filters do not create gate levels. A complete public-only or name-filtered file block at the current fingerprint satisfies orientation.

Do not mark a file oriented because the worker parsed it, it appeared in tool `details`, it exists only in overflow output, its block was partial, or the request failed or was cancelled.

Session reset clears numeric locator mappings and orientation state. Known file mutation invalidates locators, orientation, and fatal-parser fallback for affected paths. Moves invalidate old and new paths. A worker restart invalidates worker-owned locator tokens; orientation remains valid only when its stored fingerprint still matches current source.

## Gate behavior

Before returning UTF-8 text from a path, the official `read` tool must:

1. resolve and canonicalize the requested path;
2. identify whether the file is supported by the currently available worker;
3. fingerprint the current source through the established freshness boundary;
4. check for a visible orientation record with the same fingerprint;
5. if absent, check for a fatal-parser fallback with the same fingerprint;
6. reject with a short routing error when neither record exists; and
7. otherwise continue through the existing read cache, diff, snapshot, line-number, and ranged-read behavior.

The rejection identifies the blocked path, says it is supported source without a current visible outline, and gives the exact next action: `outline` the file or an owning subtree.

Do not return outline output from a tool call named `read`.

The initial gate has:

- no file-size exemption;
- no exemption for ranged reads;
- no separate requirement for private or unfiltered outlines;
- no requirement to call `symbol` before a later read;
- no gate for unsupported prose, configuration, data, or binary files;
- no gate when the worker artifact or required capability is unavailable; and
- no claim that shell reads are blocked.

Markdown is supported source for this policy. Image and invalid UTF-8 delegation remain unchanged.

## Telemetry

Extend `/read-stats` to distinguish:

- blocked read attempts;
- source bytes avoided by visible AST output;
- later permitted reads;
- bytes actually returned to model context;
- fatal-parser fallback reads; and
- overflow-file bytes later read by the agent.

Keep worker input bytes, complete rendered bytes, model-visible AST bytes, temporary-file bytes, and direct-read bytes separate. Temporary bytes are not savings when the agent later reads them.

## Likely files

- `packages/agent/extensions/explore/index.ts`
- `packages/agent/extensions/explore/read.ts`
- `packages/agent/extensions/explore/ast-tools.ts`
- `packages/agent/extensions/explore/read-stats.ts`
- one small Explore-local orientation-state module if inline state would duplicate logic
- `packages/agent/test/extensions/explore/read.test.ts`
- `packages/agent/test/extensions/explore/ast-tools.test.ts`
- complete-file visibility and mutation tests

Use the existing Explore state owner. Do not introduce a generic `tool_call` interception layer when the overridden read implementation can enforce the contract directly.

## Validation

- The first whole-file and ranged read of supported source is blocked.
- A complete visible outline unlocks that exact current file fingerprint.
- A sibling outline does not unlock the requested file.
- Public-only and name-filtered outlines unlock a fully visible file block.
- Overflow-only and partial blocks remain blocked.
- Mutation or external source change makes orientation stale.
- Unsupported text, binary delegation, cache diffs, line numbers, and snapshots retain current behavior after the gate is satisfied.
- Missing worker artifacts never strand the agent.
- A recorded fatal per-file failure allows an ordinary read only at the matching fingerprint.
- `/read-stats` reports blocked, deflected, permitted, fallback, and returned bytes without double counting.

## Completion

Phase 3 is complete when Tau's official reads reliably enforce one current model-visible outline per supported file, preserve all existing read behavior after orientation, and always provide a safe route around unavailable or fatally failing AST support.
