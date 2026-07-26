# Phase 0: Progressive AST Behavioral Contract

Status: approved; Phase 1 may begin  
Captured: 25 July 2026

## Outcome

Lock the behavior that later phases must implement. This phase changes no code.

Tau already ships first-party `outline` and `symbol` tools backed by a package-private Rust worker. They support TypeScript, TSX, Odin, Go, Rust, C#, Java, Kotlin, Swift, and Markdown. Current tools provide file and non-recursive package outlines, exact-name filtering, private expansion, numeric model-facing locators, fingerprinted native locators, and exact declaration retrieval.

The remaining work turns those tools into the default source-exploration path, then adds repository discovery, structural search, relationships, and locator-based edits.

## Workflows to approve

1. **Known-package reuse:** public outline → documented signature → reuse API.
2. **Unknown-location reuse:** repository API discovery → candidate contracts → export and import provenance → reuse API.
3. **Localized edit:** private or name-filtered outline → exact declaration with required imports → patch known source.
4. **Impact edit:** selected declaration → direct callers and tests → nearest editable scopes → implementation and test changes.
5. **Parser degradation:** expose uncertainty; allow a fingerprinted read fallback when an outline attempt cannot produce a usable file result.
6. **Unsupported file:** use ordinary textual exploration without AST friction.
7. **Long Markdown:** use ordinary reads by default; use headings and section retrieval when they reduce context.

## Rules to approve

- Explore owns source-exploration policy. Soul keeps general tool discipline without prescribing whole-file reads.
- Repository guidance names only languages both present under the working root and supported by the available worker.
- `outline` keeps file and non-recursive package behavior and gains recursive mixed-language orientation.
- Recursive traversal completes independently of model-output limits and streams bounded worker frames.
- Overflow mirrors Pi behavior: bounded model output, exact shown and total sizes, and a complete temporary file.
- Tool `details` remains bounded. It does not retain complete recursive results or rendered output.
- The read gate applies only to worker-supported source paths selected by Explore's required include and exclude globs. Exclusions win.
- Default gate settings include supported source generally and exclude Markdown. Markdown remains available to AST tools without requiring structural access before ordinary reads.
- A gated source file requires a completed structural attempt tied to its current source fingerprint before official whole-file or ranged reads.
- Direct file outlines and structural searches qualify even when they return no match or bounded output truncates their preview.
- API candidates, structural matches, symbol declarations, relationship locations, and editable scopes qualify their represented files whether their complete result remains in model output or overflows to temporary storage.
- Files merely traversed, filtered, parsed, or scanned as background work do not qualify.
- A known successful Tau patch may return a trusted complete-file cached diff when the retained model branch contains the prior baseline and the mutation identifies the exact resulting fingerprint.
- Tiny gated files have no size exemption.
- A successful degraded outline records a structural attempt while keeping parser warnings visible.
- A fatal per-file AST failure after an outline attempt creates only a fingerprinted read fallback. It creates no successful-attempt record or locator.
- The read gate disables itself when the worker is unavailable. Unsupported files keep normal read behavior.
- `symbol` is preferred for declarations and its current model-visible result may satisfy the later file-level read gate.
- Numeric locators are session-local. Native locators remain fingerprinted and stale-safe.
- Repository API discovery is separate from structural `ast_search`.
- Relationship results state exact, inferred, or ambiguous certainty and include the nearest safe editable scope.
- Locator-based edits are required for the final no-textual-read workflow. General pattern rewriting remains separate.
- Tau can enforce progression through official tools. Unrestricted shell access remains an escape route.
- The gate may be strengthened or relaxed only through explicit Phase 8 work or the evidence review in Phase 10.

## Phase order

1. Move policy into Explore and detect capabilities.
2. Add recursive streaming outline and overflow.
3. Enforce the first-outline read gate.
4. Add `signatureWithDocs`.
5. Add repository API discovery.
6. Add structural search.
7. Add relationships and editable scopes.
8. Make the read gate configurable, accept current structural attempts, and add safe post-mutation diffs.
9. Add locator-based edits.
10. Ratify the final policy from recorded evidence.

Phases 1 through 3 may be approved as one coherent batch. Every later phase requires separate approval.

## Required reference validation

Before this phase is complete, run its applicable acceptance workflow against all nine read-only reference repositories and the Markdown fixture in [`language-verification-corpus.md`](./language-verification-corpus.md). Unit tests and phase-specific fixtures do not replace this pass. Treat a failure in any supported language as a phase blocker and record parser recovery or uncertainty explicitly.

## Completion

Phase 0 is complete. The workflows, rules, and phase order above are approved.
