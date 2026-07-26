# Phase 2: Recursive Streaming Outline

Status: implementation unapproved  
Depends on: Phase 1 capability-aware Explore policy  
Produces: bounded recursive mixed-language orientation with complete overflow output

## Current state

The Rust worker is a long-lived package-private process controlled by Explore. It uses a versioned, length-prefixed JSON protocol over stdin and stdout, request IDs, cancellation, fingerprinted locators, in-memory parse state, and bounded stderr. Tau restarts it after protocol failure and closes it on session shutdown.

The established boundary remains one package-private worker selected and started by Tau. This phase does not add a user-facing CLI, switch to N-API or WebAssembly, load third-party grammars at runtime, or add persistent storage.

Current outline targets cover one file or immediate files in one package directory. Directory handling rejects mixed language families, can drop Markdown when another supported language is present, and returns one complete `OutlineTargetResult` frame. Protocol frames have an 8 MB ceiling.

The TypeScript wrapper currently renders the complete result into one string, stores the complete structured result in tool `details`, then applies ordinary head truncation. That shape cannot safely scale to a repository: the worker can exceed its frame limit before TypeScript truncates anything, and session storage can retain the unbounded result.

Pi's outer model limits are 50 KB or 2,000 lines. Recursive traversal limits must be separate from those output limits.

The original native spike measured roughly 5.9 ms cold startup and 0.15–0.17 ms warm extraction on macOS arm64. Preserve before-and-after benchmark records, but do not turn noisy wall-clock thresholds into normal correctness tests.

## Decisions required before coding

Resolve these in this phase and record the answers here:

1. Recursive target schema: explicit recursive mode, distinct target form, or depth-based target.
2. Default and maximum traversal budgets for file count, source bytes, depth, and elapsed work.
3. Whether output includes unsupported directory structure or only supported source paths.
4. Temporary-file lifetime and cleanup policy.

Do not use model-output exhaustion as an implicit traversal limit.

## Native traversal

1. Keep existing file and non-recursive package behavior.
2. Add recursive repository or subtree traversal using the existing working-root boundary.
3. Use gitignore and standard ignore behavior. Prune ignored directories before reading files.
4. Detect each supported file independently so one traversal can contain every supported language.
5. Sort model output deterministically by canonical relative path even if parsing runs in parallel.
6. Honor cancellation while walking, reading, parsing, and sending results.
7. Report unreadable, skipped, oversized, unsupported, and parser-degraded files explicitly.
8. Finish within the explicit traversal budgets even after model-visible output is full.
9. Keep source and syntax-tree caching in process memory only. Do not add a persistent repository index.

Use the existing `ignore` and parallel-worker foundation where available. Parser instances should remain per-language and per-worker-thread. Full reparsing remains acceptable; this phase does not add approximate Tree-sitter edits.

## Streaming protocol

Extend the framed protocol so one request can produce:

1. a start frame with canonical target and options;
2. bounded per-file result frames;
3. bounded progress or diagnostic frames;
4. one final frame with aggregate counts and completion status; and
5. a terminal error or cancellation result.

Every frame must remain below `MAX_FRAME_BYTES`. Preserve request IDs across all frames. The TypeScript client must distinguish stream frames from final responses, apply backpressure, remove abort listeners, and reject the whole tool call after malformed frames, worker exit, or protocol failure.

Do not advertise partial output as complete. A failed or cancelled stream creates no orientation state.

## Incremental rendering and overflow

1. Render each file block once as its result arrives.
2. Register numeric locators only after their native tokens are stored.
3. Append every rendered block to the complete-output stream.
4. Retain only the model-visible prefix, locator mappings, aggregate counters, and bounded metadata in memory.
5. Prefer complete file blocks. If the next block does not fit, omit it from model content rather than cutting it.
6. If one file block exceeds the entire budget, return a clear partial-file notice and require a narrower file outline before that file can count as visible.
7. Mark exactly which complete file blocks reached model-visible content. Phase 3 will use this set for orientation.

When output exceeds Pi's line or byte cap, write the complete rendered output to a temporary text file. The notice must report:

- shown lines and total lines;
- shown bytes and total bytes;
- absolute temporary path;
- complete file line and byte size;
- that reading the temporary file whole will hit normal limits again; and
- that targeted `grep` or ranged `read` can inspect the overflow file.

Create the temporary file lazily or stream into it from the beginning. Never buffer the complete rendered output first. Remove incomplete files after cancellation or failure.

The temporary output must contain every rendered file block and its numeric locator values. Every locator written there remains registered even when its file block is outside the model-visible prefix. Those files still do not satisfy orientation. Locator mappings remain session-local and stale-safe.

Tool `details` may contain target, counts, source totals, returned and complete output sizes, truncation status, completion status, and temporary path. It must not contain every declaration or the complete rendered output.

## Likely files

- `packages/agent/extensions/explore/ast-worker.ts`
- `packages/agent/extensions/explore/ast-tools.ts`
- `packages/agent/native/tau-ast/src/main.rs`
- `packages/agent/native/tau-ast/src/protocol.rs`
- `packages/agent/native/tau-ast/src/outline.rs`
- worker and Explore AST tests

Relevant implementation patterns already validated by repository research are gitignore-aware parallel walking, per-thread parsers, deterministic post-walk ordering, and process-resident cache reuse. Do not copy external CLI or JSON contracts into Tau's public tool schema.

## Validation

- A recursive mixed-language fixture returns deterministic grouped output.
- Ignored and unsupported files are not parsed.
- A rendered result larger than 8 MB completes through bounded frames.
- A result beyond Pi's limits returns bounded model content and one complete temporary file.
- Exact shown and total line and byte counts match the written output.
- Session transcript details remain bounded.
- Cancellation removes incomplete overflow files and leaves the worker usable or restarts it cleanly.
- Worker crash, malformed frame, and protocol mismatch reject partial results.
- Files wholly outside the visible prefix and partial file blocks are identified as not visible.

## Completion

Phase 2 is complete when recursive repository orientation is mixed-language, deterministic, cancellable, independent of model-output limits, safe beyond the worker's old frame ceiling, and explicit about exactly which file blocks reached the model.
