# Tool-hook scanning

Approved scope: fix tool-call lag and read-only settlement checks in Tau; configure the tau-born-again worktree to leave downloaded reference trees alone.

## Architecture

- Shared file scopes compile glob segments once and distinguish file matching from possible descendants. A shared walker prunes directories outside every scope and stops on cancellation.
- Silent Command Runner snapshots only paths covered by its configured commands. Content hashes and observed additions/deletions select checks; potential-write revisions still invalidate prior verification. Empty check selections produce no progress widget.
- Markdown formatting uses the same walker and scans after outer modifying calls, not reads or nested calls already covered by an outer call.
- Worktree Markdown exclusions cover the file-finder corpus and copied dependency docs, retaining the default exclusions.

## Boundaries and call paths

`createFileScope(includeGlobs, excludeGlobs): FileScope` supplies `matches(path)` and `canDescend(path)`.

`walkFiles(root, scopes, signal): Promise<string[]>` serves both extensions. Production command settings inject the scopes; read-only in-memory probes use the same functions against the worktree.

Tool hooks take content snapshots around potential writes, record changed paths, then run fixers for matching files. `checks` and settlement select commands from those paths and the run baseline, preserving failed-command retries and nested-call invalidation.

## Cache and verification

The provider request shape does not change. Prompt contributions and tool descriptions remain stable for unchanged settings; no mutable scan state enters model requests. Check failures still use the shared bounded output handler.

Verify glob semantics against the previous matcher in memory, benchmark scoped worktree scans, inspect mutation/deletion and nested-check behavior, then run repository checks. Live extension verification requires `/reload`.

## Implementation results

Implemented the shared scopes and walker, content-based check selection, quiet empty settlement, and outer-call Markdown scans. Previously failed checks remain eligible for settlement even when no later tool invalidated their revision. Deletion-only snapshots advance after processing so nested checks do not rediscover the same deletion after a retry.

Read-only probes preserved matching and retained-path pruning across 33,984 comparisons against the previous matcher. In tau-born-again, fixer scanning covers 19 files in about 3 ms including hashing; check scanning covers 22 files in about 2 ms including hashing. Markdown scanning retains 43 project files and prunes both downloaded reference trees. Cancellation stops traversal. All three existing worktree hook tests passed.

Live Pi tool-hook behavior remains to be verified after the user runs `/reload` in the affected sessions.
