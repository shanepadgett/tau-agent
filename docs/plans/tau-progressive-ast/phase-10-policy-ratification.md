# Phase 10: Progressive Exploration Policy Ratification

Status: implementation unapproved  
Depends on: observed use of Phases 1 through 9  
Produces: an evidence-backed final exploration policy

## Current policy under review

Tau's rollout policy requires a current structural attempt before official whole-file or ranged reads of configured source. Explore applies the gate only to worker-supported paths that match its include globs and no exclude glob. Markdown is excluded by default while its AST tools remain available.

A completed direct-file outline or structural search qualifies at the exact file fingerprint, including zero-result and truncated-preview responses. API candidates, structural matches, symbol declarations, relationship locations, and editable scopes qualify the files they represent. Result records still qualify when bounded rendering moves them to temporary overflow. Background traversal or scanning alone does not qualify every visited file. Invalid requests, cancellations, and failures without a trustworthy fingerprint do not qualify. Fatal per-file AST failures can create a fingerprinted read fallback. Missing worker capability disables the gate.

A successful Tau `patch` may also permit a complete-file cached diff when the model-visible branch retains the prior complete-file baseline and the mutation event identifies the exact resulting fingerprint. This permit does not preserve stale AST locators or let an external edit bypass current-source checks.

The intended mature workflow is:

```text
orient
→ discover public surface
→ inspect contract
→ retrieve exact declarations
→ discover relationships
→ edit by locator
→ use textual source when structural access cannot answer safely
```

Phase 10 decides whether recorded behavior justifies keeping or revising that policy. Do not tighten or relax the gate as an incidental change in another phase.

## Evidence required

Collect real session cases covering:

- configured tiny files where a structural attempt helped or created waste;
- include and exclude glob choices, especially teams that gate Markdown explicitly;
- targeted reads needed for formatting, comments, or source outside declaration boundaries;
- recovered and fatal parser failures in every supported language;
- lexical queries where `grep` was more accurate or cheaper than structural tools;
- unknown-location API reuse through package surfaces and re-exports;
- implementation changes with direct caller and test discovery;
- locator edits across implementation and test files;
- stale-source and ambiguous-reference failures;
- direct-file and result-based structural attempts used to satisfy the read gate;
- post-patch cached diffs, including missing or pruned baselines and later external edits;
- recursive overflow use, including later reads from temporary files;
- missing-worker behavior; and
- shell escape use when official tools could not complete the task.

Use recorded failures, tool telemetry, and reproducible fixtures. Anecdotes without the relevant tool sequence and byte accounting are insufficient to change policy.

## Accounting contract

Keep these measurements separate:

- source bytes parsed by the worker;
- complete rendered AST output bytes;
- AST bytes returned to model context;
- bytes written to overflow files;
- overflow bytes later read by the model;
- source bytes returned through `read`;
- blocked and permitted read attempts; and
- source bytes actually avoided compared with the read path the agent attempted.

Do not call worker input or unread temporary-file content a model-context saving. Do not count the same deflected read again after mutation or fallback.

Performance evidence may record cold worker startup, first parse by grammar, warm outline and symbol latency, recursive scan latency, files filtered and parsed, cancellation time, resident memory, cache hits, and IPC transfer time. Keep noisy wall-clock benchmarks outside normal correctness gates.

## Review questions

1. Does the structural-attempt rule avoid repeated orientation work without allowing one broad background scan to permit unrelated files?
2. Which targeted reads remain the safest way to inspect formatting, comments, or non-declaration source?
3. Does the fatal-parser fallback trigger only when structural access is unusable?
4. When is lexical `grep` the correct tool rather than a structural substitute?
5. Does API discovery prevent candidate implementation reads during reuse work?
6. Do relationship results find the direct callers and tests needed for real changes?
7. Do editable-scope locators cover framework callbacks and test structures accurately enough?
8. Do locator edits fail safely on stale and ambiguous input?
9. Are read statistics measuring model-visible context rather than worker or temporary-file volume?
10. Does any supported language or configured file class have adapter quality too weak for mandatory gating?
11. Do known-patch diff permits remain tied to retained model knowledge and the exact resulting fingerprint?
12. Are include and exclude globs understandable enough to tune gated file classes without creating accidental coverage gaps?

## Decision procedure

1. Group failures by policy, parser or adapter correctness, missing capability, and agent misuse.
2. Fix correctness defects before using them as evidence against the workflow.
3. Propose each policy change explicitly with affected languages, file classes, and telemetry consequences.
4. Add or update acceptance fixtures before changing enforcement.
5. Update Explore guidance, read-gate behavior, `/read-stats`, Explore docs, and Tau help together.
6. Record the final policy in maintained product or architecture documentation.

Changing the no-size-exemption rule requires explicit evidence. Shell guidance may prefer dedicated tools but must not claim unrestricted shell access is enforceable. Glob configuration is the file-class policy surface; no per-call bypass is introduced without separate approval.

## Likely files

- recorded session evidence under `docs/plans/` while review is active
- `packages/agent/extensions/explore/read.ts`
- `packages/agent/extensions/explore/read-stats.ts`
- Explore guidance and AST tools when policy wording changes
- read-gate and telemetry tests
- `packages/agent/extensions/explore/README.md`
- `packages/agent/extensions/tau-help/help.md`
- maintained Tau architecture documentation for the ratified contract

## Required reference validation

Before this phase is complete, run its applicable acceptance workflow against all nine read-only reference repositories and the Markdown fixture in [`language-verification-corpus.md`](./language-verification-corpus.md). Unit tests and phase-specific fixtures do not replace this pass. Treat a failure in any supported language as a phase blocker and record parser recovery or uncertainty explicitly.

## Completion

Phase 10 is complete when evidence supports an explicit keep-or-revise decision, the chosen policy has regression coverage and maintained documentation, and temporary planning evidence can be removed.
