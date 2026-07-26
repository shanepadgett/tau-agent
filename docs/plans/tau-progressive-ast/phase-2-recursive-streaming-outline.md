# Phase 2: Recursive Streaming Outline and Shared Overflow Handling

Status: implemented
Depends on: Phase 1 capability-aware Explore policy  
Produces: bounded recursive mixed-language orientation and Tau's shared text-result overflow handler

## How it works

`outline` currently handles one file or one directory level. Phase 2 adds a recursive mode for a repository or subtree. It respects ignore rules, handles every supported language in one run, returns files in stable path order, and stops at explicit traversal limits.

The worker sends one file at a time instead of building one enormous response. Tau keeps complete file blocks that fit in model context and streams the full outline to a temporary file when it overflows. The agent receives exact counts, the temporary path, and numeric `symbol` locators.

This phase also creates the shared bounded text-result handler that future Tau tools will use. The handler controls model-visible output, overflow metadata, temporary files, and cleanup. Tool-specific result shapes and TUI rendering stay with each tool.

## Fixed decisions

- Existing file and non-recursive package outlines keep their behavior.
- Recursive traversal has its own file-count, source-byte, depth, and elapsed-work limits. Model-output limits never control how much repository work is performed.
- The shared handler imports Pi's `DEFAULT_MAX_BYTES` and `DEFAULT_MAX_LINES`. Tools do not copy, pass, or choose those model-visible limits.
- Overflow selection is a strategy. Head retention reuses Pi's exported `truncateHead`, tail retention reuses Pi's exported `truncateTail`, and Tau supplies complete-block retention. Recursive outline uses complete blocks.
- Overflow files are valid for the active session and disposable afterward.
- Full output is never buffered in memory before being written.
- Source and syntax-tree caches remain process memory only. No persistent repository index is added.

## Resolved implementation decisions

1. The tool accepts `recursive: true` for directories. The worker receives a distinct `recursiveDirectory` target so non-recursive directory behavior cannot change accidentally.
2. Tau sends fixed recursive budgets of 2,000 supported files, 64 MiB of source, depth 32, and 20 seconds. Native hard caps are 10,000 files, 256 MiB, depth 128, and 60 seconds. These are internal safety limits, not settings or extra tool parameters.
3. Recursive output contains supported source-file blocks only. Unsupported files and ignored paths do not create structural output; the final summary reports aggregate counts. Supported files that are unreadable, oversized, or fail parsing get path-specific diagnostics.
4. Temporary output is limited to 64 MiB per file and 256 MiB per session.
5. Startup cleanup may remove a marked orphan directory after 24 hours. It first checks the owner marker and preserves directories whose owner process is still alive.

## Shared bounded text-result handler

The handler runs while constructing the result returned by `execute`. Applying limits only in `renderResult` is too late because the unbounded content would already be stored in the session and sent to the model.

The shared handler must:

1. Accept streamed text units without buffering the complete output.
2. Enforce Pi's model-visible byte and line defaults automatically.
3. Support head, tail, and complete-block retention without changing `AgentToolResult` or forcing one tool-specific details shape. Head and tail snapshots must delegate to Pi's exported `truncateHead` and `truncateTail`; the shared handler must not reimplement their truncation semantics.
4. Return bounded model `content` plus standard overflow details: strategy, shown and total lines, shown and total bytes, completion state, and temporary path.
5. Allow structured callers to attach identifiers for complete visible units. Recursive outline uses those identifiers to record which files reached the model.
6. Offer an optional common TUI formatter for the standard overflow details. Custom tool rows and expanded renderers remain allowed.
7. Reject or clearly mark incomplete full output when a disk quota, write failure, cancellation, or producer failure prevents completion.

Phase 2 is the first consumer. The deferred tool-result audit migrates other Tau tools later.

## Temporary-file lifecycle

The shared handler owns a session-scoped directory under the OS temporary directory. Using `os.tmpdir()` chooses a location; it does not provide cleanup.

- Create the session directory lazily with owner-only permissions.
- Create overflow files with owner-only permissions and unpredictable names.
- Delete incomplete files immediately after cancellation, producer failure, or write failure.
- Keep successful files available for `grep` and ranged `read` during the active session.
- Remove the complete session directory on `session_shutdown`. Shutdown remains idempotent.
- On startup, remove only clearly marked Tau overflow directories older than the approved orphan lifetime.
- Enforce per-file and per-session disk quotas. Never rely on eventual OS cleanup for disk safety.

The tool-result notice must state that the path is temporary and valid only for the active session.

## Native traversal

1. Walk recursively within the existing working-root boundary.
2. Apply gitignore and standard ignore behavior before entering ignored directories.
3. Detect every supported file independently so mixed-language repositories work in one request.
4. Sort model output by canonical relative path even if parsing runs in parallel.
5. Honor cancellation while walking, reading, parsing, and sending results.
6. Report unreadable, skipped, oversized, unsupported, and parser-degraded files explicitly.
7. Finish within traversal limits even after model-visible output is full.
8. Keep parser instances per language and worker thread. Full reparsing remains acceptable.

## Streaming worker protocol

One recursive request produces:

1. a start frame with the target and options;
2. bounded per-file result frames;
3. bounded progress or diagnostic frames;
4. one final frame with aggregate counts and completion status; and
5. a terminal error or cancellation result.

Every frame stays below the existing 8 MB worker frame ceiling and keeps the same request ID. The TypeScript client applies backpressure, removes abort listeners, and rejects the complete operation after malformed frames, worker exit, protocol mismatch, cancellation, or terminal failure. Failed and cancelled streams create no orientation state.

## Visible output and locators

1. Render each file block once as it arrives and append it to the shared handler.
2. Register numeric locators after their native tokens are stored.
3. Prefer complete file blocks in model content. Omit the next block when it does not fit.
4. If one block exceeds the complete model budget, show a partial-file notice and require a narrower file outline before that file counts as visible.
5. Keep locator mappings for every complete block written to the full temporary output, including blocks outside model content.
6. Mark exactly which complete file blocks reached model content. Phase 3 uses that set for orientation.
7. Keep session details bounded. Do not store every declaration or the complete rendered output in tool `details`.

The overflow notice reports shown and total lines, shown and total bytes, the absolute temporary path, and the complete file size. It warns that reading the entire temporary file will hit the same model-output limits and recommends targeted `grep` or ranged `read`.

## Likely files

- shared bounded text-result handler and temporary-store files under `packages/agent/shared/`
- shared handler tests
- `packages/agent/extensions/explore/index.ts` for session lifecycle wiring
- `packages/agent/extensions/explore/ast-worker.ts`
- `packages/agent/extensions/explore/ast-tools.ts`
- `packages/agent/native/tau-ast/src/main.rs`
- `packages/agent/native/tau-ast/src/protocol.rs`
- `packages/agent/native/tau-ast/src/outline.rs`
- worker and Explore AST tests

## Validation

- A recursive mixed-language fixture returns deterministic grouped output.
- Ignored and unsupported files are not parsed.
- A rendered result larger than 8 MB completes through bounded frames.
- Model content never exceeds Pi's limits and contains only complete visible file blocks.
- Full temporary output contains every rendered block and locator with exact line and byte counts.
- Session transcript details remain bounded.
- Cancellation and failures remove incomplete files and create no orientation state.
- Session shutdown removes successful overflow files and is idempotent.
- Startup cleanup removes only old, marked Tau overflow directories.
- Disk quotas fail safely without claiming the temporary output is complete.
- Worker crash, malformed frame, and protocol mismatch reject partial results.
- The existing file, package, language-fixture, and real-package suites remain green.
- Preserve before-and-after native benchmark records without adding noisy wall-clock correctness thresholds.

## Required reference validation

Before this phase is complete, run its applicable acceptance workflow against all nine read-only reference repositories and the Markdown fixture in [`language-verification-corpus.md`](./language-verification-corpus.md). Unit tests and phase-specific fixtures do not replace this pass. Treat a failure in any supported language as a phase blocker and record parser recovery or uncertainty explicitly.

## Completion

Phase 2 is complete when recursive repository orientation is mixed-language, deterministic, cancellable, safe beyond worker and model limits, and explicit about which files reached the model. The shared bounded text-result handler must be ready for later Tau tool migrations and must clean up its temporary files under normal shutdown, failure, cancellation, and stale-orphan paths.
