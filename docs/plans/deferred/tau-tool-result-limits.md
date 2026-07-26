# Deferred: Migrate Tau Tools to Shared Bounded Results

Status: deferred and unapproved  
Depends on: Phase 2 shared bounded text-result handler

## Goal

Route every existing Tau tool capable of returning unbounded model-visible text through the shared bounded text-result handler introduced in Phase 2.

The migration does not choose byte or line limits. The shared handler owns Pi's defaults, overflow metadata, temporary storage, disk quotas, and cleanup. Each tool only chooses how useful content is retained: head, tail, complete groups or blocks, pagination, or a documented inherently bounded result.

## Work

1. Inventory every Tau tool that returns model-visible text.
2. Mark genuinely bounded and non-text results that do not need the handler, with a concrete reason.
3. Assign the correct retention strategy to every remaining tool.
4. Replace local truncation notices, temporary-file creation, and cleanup code with the shared handler.
5. Register the shared session lifecycle wherever migrated tools are loaded.
6. Preserve tool-specific `AgentToolResult` details and TUI rendering while consuming the handler's standard overflow details.
7. Delete obsolete helpers, copied limits, temporary-file code, and stale tests during each migration.
8. Add coverage proving each migrated tool returns bounded model content and provides a working recovery path for omitted output.

## Migration order

1. Tools already implementing their own truncation or overflow files, including subagent, web, Explore AST, and appshot text results.
2. Search and filesystem tools with grouped, paginated, or ranged recovery.
3. Remaining extension tools after the inventory identifies their actual output bounds.

Keep each migration green and committable. Do not convert every tool in one change.

## Out of scope

- Redesigning the shared handler established in Phase 2 unless a real migration exposes a correctness gap.
- Changing tool-specific result schemas, TUI rows, or expanded rendering without need.
- Changing traversal, source-byte, file-count, depth, elapsed-work, image, or other non-text limits.
- Routing small fixed messages through the handler merely for uniform syntax.

## Validation

- Every potentially unbounded text tool uses the shared handler.
- Every bypass is inherently bounded or non-text and records why.
- No migrated tool copies Pi's model-output limits or creates unmanaged overflow files.
- Recovery paths remain usable for the active session.
- Cancellation, failure, session shutdown, startup orphan cleanup, and disk quotas remain covered by the shared handler tests.
- Existing tool behavior and TUI rendering remain green unless an approved migration explicitly changes them.

## Completion

The migration is complete when all potentially unbounded Tau text results pass through the shared handler, local overflow implementations are gone, and every temporary output file has one session-owned cleanup path.
