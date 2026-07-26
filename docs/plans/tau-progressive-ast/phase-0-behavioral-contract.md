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
7. **Long Markdown:** outline headings → retrieve selected sections → read the whole document only when structural access cannot answer the task.

## Rules to approve

- Explore owns source-exploration policy. Soul keeps general tool discipline without prescribing whole-file reads.
- Repository guidance names only languages both present under the working root and supported by the available worker.
- `outline` keeps file and non-recursive package behavior and gains recursive mixed-language orientation.
- Recursive traversal completes independently of model-output limits and streams bounded worker frames.
- Overflow mirrors Pi behavior: bounded model output, exact shown and total sizes, and a complete temporary file.
- Tool `details` remains bounded. It does not retain complete recursive results or rendered output.
- A supported source file must have one complete, model-visible outline block at its current source fingerprint before official whole-file or ranged reads.
- Public-only and exact-name-filtered outlines satisfy orientation when their complete file block is visible.
- Files present only in overflow output and files with partially visible blocks do not satisfy orientation.
- Markdown follows the same gate. Tiny supported files have no exemption.
- A successful degraded outline satisfies orientation while keeping parser warnings visible.
- A fatal per-file AST failure after an outline attempt creates only a fingerprinted read fallback. It creates no orientation record or locator.
- The read gate disables itself when the worker is unavailable. Unsupported files keep normal read behavior.
- `symbol` is preferred for declarations but is not required before a later targeted or whole-file read.
- Numeric locators are session-local. Native locators remain fingerprinted and stale-safe.
- Repository API discovery is separate from structural `ast_search`.
- Relationship results state exact, inferred, or ambiguous certainty and include the nearest safe editable scope.
- Locator-based edits are required for the final no-textual-read workflow. General pattern rewriting remains separate.
- Tau can enforce progression through official tools. Unrestricted shell access remains an escape route.
- The gate may be strengthened or relaxed only through the evidence review in Phase 9.

## Phase order

1. Move policy into Explore and detect capabilities.
2. Add recursive streaming outline and overflow.
3. Enforce the first-outline read gate.
4. Add `signatureWithDocs`.
5. Add repository API discovery.
6. Add structural search.
7. Add relationships and editable scopes.
8. Add locator-based edits.
9. Ratify the final policy from recorded evidence.

Phases 1 through 3 may be approved as one coherent batch. Every later phase requires separate approval.

## Required reference validation

Before this phase is complete, run its applicable acceptance workflow against all nine read-only reference repositories and the Markdown fixture in [`language-verification-corpus.md`](./language-verification-corpus.md). Unit tests and phase-specific fixtures do not replace this pass. Treat a failure in any supported language as a phase blocker and record parser recovery or uncertainty explicitly.

## Completion

Phase 0 is complete. The workflows, rules, and phase order above are approved.
