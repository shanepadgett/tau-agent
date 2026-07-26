# Phase 8: Structural Read Eligibility and Post-Mutation Reads

Status: complete  
Depends on: the Phase 3 read gate, Phase 5 API discovery, Phase 6 structural search, and stale-safe symbol retrieval  
Produces: a configurable structural-attempt gate and safe post-patch cached reads

## Prior state

The official `read` tool accepts supported source only after `outline` records a complete model-visible file block at the current fingerprint. Public-only and exact-name-filtered outlines already permit reads of the whole file, so the gate is intentionally file-level rather than range-level.

Other AST tools can narrow the next source read but do not affect the gate:

- `symbol` retrieves declarations, and every `SymbolDeclaration` already carries its path and source fingerprint;
- `api_discover` returns candidate contracts and fresh locators, but `ApiCandidate` does not expose a source fingerprint to Explore;
- `ast_search` returns matches and enclosing scopes, but `AstSearchMatch` does not expose a source fingerprint; and
- relationship tools return candidate locations and editable scopes with fingerprints.

The current gate also covers every worker-supported language. That makes Markdown reads pay the same orientation cost as implementation source even though headings are an optional navigation aid rather than a necessary safety boundary. Operators cannot adjust the gated file classes without changing code.

After `patch`, `tau:file-mutation.applied` makes every locator for the changed path stale and clears its orientation record. The read snapshot and retained complete-file baseline may still be usable, but `read` checks orientation before asking the cache for a diff. This forces another outline even when the model saw the old file and authored the exact successful mutation.

## Decisions

1. Treat the gate as proof that the model tried structural access before reading source. It does not require a complete source block in model context. Avoid a broad code rename when extending the existing orientation state is clearer.
2. Configure gated paths through required `extensions.explore.readGate.includeGlobs` and `extensions.explore.readGate.excludeGlobs` arrays. A path is gated only when it matches an include and no exclusion. Exclusions win.
3. Default `includeGlobs` to all paths and default `excludeGlobs` to Markdown (`**/*.md`, `**/*.markdown`, and `**/*.mdown`). Markdown remains AST-supported and available to `outline`, `symbol`, discovery, and search; ordinary Markdown reads are ungated unless configuration removes those exclusions.
4. Configuration can narrow the gate only within worker-supported source. It cannot make unsupported files AST-gated.
5. A qualifying structural attempt permits reads of the exact file at the matching fingerprint. Keep the existing file-level gate; range-level permissions are outside this phase.
6. A broad directory scan does not permit every file it happened to parse. A file qualifies when the invocation directly targeted that file or returned that file as a result location or editable scope.
7. File mutation always invalidates old locators and old-fingerprint attempt records. Read permission must not make a stale locator usable.
8. A known successful Tau patch may permit a cached complete-file diff only when the retained model context contains the trusted prior complete-file baseline and the mutation reports the exact resulting fingerprint.
9. External edits, missing baselines, pruned baselines, additions without a baseline, failed mutations, and mismatched fingerprints do not receive the patch permit.

## Qualifying structural attempts

Record a current structural attempt for:

- a completed file-targeted `outline` or file-targeted `ast_search`, including zero-result and recoverable-diagnostic responses;
- every file result produced by package or recursive `outline`;
- every declaration path represented by a completed `symbol` result;
- every candidate path produced by `api_discover` after the protocol adds its defining source fingerprint;
- every match path produced by `ast_search` after the protocol adds its source fingerprint; and
- every candidate location and editable-scope path produced by a relationship tool at a current fingerprint.

Bounded rendering does not control permission. Result records qualify whether they appear in model content or only in the complete temporary overflow file. A truncated preview also qualifies because the structural attempt already narrowed the file. For a direct file target, a zero-result response qualifies when the worker completed the request and reported that file's current fingerprint.

An invalid request, cancellation, transport failure, or worker failure without a trustworthy file fingerprint does not qualify. Fatal per-file parser failure keeps the existing fingerprinted fallback. Merely traversing, filtering, parsing, or scanning a file as background work does not qualify unless the invocation directly targeted it or returned it as a result.

Do not decode opaque native locator tokens in TypeScript to recover fingerprints. Carry fingerprints as explicit protocol fields.

## Gate configuration

Add `packages/agent/extensions/explore/settings.ts` and keep the setting next to the extension. Match slash-normalized paths consistently for root-level, nested, relative, and absolute tool inputs. Tests must pin exclusion precedence and root-level Markdown behavior.

The gate decision order is:

1. unsupported by the available worker: ungated;
2. no include-glob match: ungated;
3. any exclude-glob match: ungated;
4. matching current structural attempt or fatal fallback: permitted;
5. exact eligible post-patch cached diff: permitted; and
6. otherwise: blocked with a focused AST routing error.

Changing the setting takes effect through the normal extension reload path. Do not add a per-call bypass.

## Post-patch cached reads

Extend each successful changed-file mutation event with the resulting source fingerprint. Deleted paths have no resulting fingerprint. Moves report the resulting fingerprint for the destination while the source remains invalidated.

For a configured source read without a current structural attempt:

1. compute the current fingerprint through the existing read freshness boundary;
2. require a matching successful-patch record for that canonical path and fingerprint;
3. require a trusted complete-file baseline retained in the current model branch;
4. construct the normal complete-file cache response against that baseline;
5. return only a valid `diff` or `unchanged` response under this permit; and
6. block and route to a qualifying AST tool when the cache would need to return an untrusted full baseline instead.

The permit does not apply to ranged reads. A successful diff becomes a normal current read-cache baseline through the existing dependency chain. A later mutation or fingerprint mismatch invalidates the permit.

Partial patch operations may grant permits only for the changes reported as successfully committed. Failed sections grant none.

## Implementation

1. Add required read-gate glob settings in Explore's `settings.ts`, with Markdown excluded by default.
2. Add explicit source fingerprints to API candidates, structural matches, relationship locations, and any direct-file response that currently lacks one. Update Tau's native protocol, TypeScript result types, validators, fixtures, and render-path tests.
3. Generalize `OrientationState` so qualifying AST attempts can record file-level permission without pretending every background-scanned file was attempted directly.
4. Register attempt records from complete worker results before bounded model-output selection. Keep model-visible and overflow byte accounting separate from permission.
5. Extend mutation change records with the resulting fingerprint produced at the mutation boundary. Keep path and move invalidation unchanged.
6. Track matching post-patch read permits separately from locator state.
7. Let `read` apply worker support and glob configuration, then consult current structural attempts, then the exact post-patch cached-diff path, before returning the routing error.
8. Update the routing error to suggest the narrowest useful attempt: exact-name `outline`, focused `api_discover`, file-scoped `ast_search`, or `symbol` from a fresh locator.
9. Keep fatal-parser fallback, unsupported-file behavior, image and binary delegation, snapshot epochs, context-pruning replay, and worker-unavailable behavior unchanged.
10. Extend telemetry to distinguish direct outline, symbol, API candidate, structural match, relationship scope, fatal fallback, and post-patch-diff permissions without double-counting source bytes avoided.

## Likely files

- `packages/agent/extensions/explore/orientation-state.ts`
- `packages/agent/extensions/explore/settings.ts`
- `packages/agent/extensions/explore/ast-tools.ts`
- `packages/agent/extensions/explore/ast-worker.ts`
- `packages/agent/extensions/explore/read.ts`
- `packages/agent/extensions/explore/read-cache.ts`
- native protocol, API discovery, and structural-search result types
- `packages/agent/extensions/patch/executor.ts`
- `packages/agent/extensions/patch/index.ts`
- `packages/agent/shared/events.ts`
- Explore AST, read-gate, cache, mutation-event, and telemetry tests
- Explore and Tau help documentation

## Validation

- Markdown reads are ungated by default while Markdown AST tools remain available.
- Include and exclude globs work for root-level and nested paths; exclusions win.
- Configuration cannot gate a worker-unsupported file.
- A completed direct-file outline or structural search permits that file at its reported current fingerprint, including zero-result and truncated-preview responses.
- API candidates, structural matches, symbol declarations, relationship locations, and editable scopes permit only their represented current files.
- Overflow-only result records qualify without counting overflow bytes as model-visible AST output.
- Background scanning without a direct target or returned file record does not permit a read.
- Invalid requests, cancellations, and failures without a trustworthy fingerprint do not permit reads.
- Mutation keeps every old locator stale regardless of a later read permit.
- A retained complete read followed by a successful patch returns a cached diff without another outline.
- A pruned or missing baseline, ranged read, added file, failed patch section, external edit, or fingerprint mismatch still requires a current structural attempt.
- Partial patches grant permits only for committed changes.
- Existing exact-name outline, fatal fallback, unsupported source, worker-unavailable, snapshot, and cache-diff behavior remains green.
- Telemetry identifies the permission source and counts only bytes actually withheld from or returned to model context.

## Required reference validation

Before this phase is complete, run its applicable acceptance workflow against all nine read-only reference repositories and the Markdown fixture in [`language-verification-corpus.md`](./language-verification-corpus.md). Unit tests and phase-specific fixtures do not replace this pass. Treat a failure in any supported language as a phase blocker and record parser recovery or uncertainty explicitly.

## Implementation record

Protocol 12 carries explicit source fingerprints for API candidates, structural matches, direct-file search responses, relationship locations, relationship targets, competing candidates, and editable scopes. Explore records completed result locations before bounded rendering, while locator visibility and temporary overflow remain separate concerns.

`extensions.explore.readGate.includeGlobs` and `excludeGlobs` now select worker-supported source paths. Exclusions win, and Markdown is excluded by default. Current structural attempts are fingerprint-bound. Successful patch changes report the exact resulting SHA-256 fingerprint; a matching permit can return only a trusted complete-file `diff` or `unchanged` response from a retained branch baseline. Mutation still invalidates every old locator and attempt.

Focused Explore and patch scenario tests passed, including exclusion precedence, default and configured Markdown behavior, zero-match direct-file search, result-based permissions, stale fingerprints, trusted post-patch diffs, missing baselines, ranges, and fingerprint mismatches. Native unit and worker integration tests passed, and the release worker was rebuilt.

Live acceptance in a reloaded Tau session confirmed the same boundaries. Supported source blocked before orientation; default Markdown and unsupported text remained ungated. Zero-result direct-file outline and search attempts permitted only their fingerprinted targets, package outlines permitted emitted files, API discovery permitted returned candidates without permitting background-scanned files, and symbol and relationship results permitted only represented locations and scopes. External edits invalidated permission. Successful patches returned useful cached diffs when a complete baseline remained, while ranged reads, additions without a baseline, failed patch sections, tiny changes where full source was cheaper, and fingerprint mismatches stayed blocked. Partial patches granted permits only for committed changes. This pass exposed and fixed a native zero-result direct-file outline bug: `outline` had discarded its empty fingerprinted file result during name filtering. The regression is covered, native tests pass, and the release worker was rebuilt after the fix.

Protocol-12 acceptance passed against the required TypeScript, TSX, Rust, C#, Go, Java, Odin, Kotlin, Swift, and Markdown targets. Every code-language declaration returned the expected documented signature, a documentation-free signature, an exact declaration with attached source comments, and matching source fingerprints. The Markdown fixture returned a fingerprinted heading locator and its complete section. Existing Java, Odin, and Swift recovery behavior did not widen for the selected declarations.

## Completion

Phase 8 is complete when the configurable gate requires one useful structural attempt for gated source, leaves Markdown ungated by default, accepts direct and result-based AST attempts at an exact file fingerprint, and lets a known successful patch return a trusted cached diff without preserving stale AST identity or requiring redundant orientation.
