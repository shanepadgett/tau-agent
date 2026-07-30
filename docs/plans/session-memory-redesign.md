# Session memory redesign

Status: approved and implemented.

## Purpose

Let an agent run for hours while keeping model context and input cost bounded. Raw conversation, file reads, research, and tool output should disappear once the agent has retained the minimum information needed to continue correctly.

The system manages distilled session state. It does not preserve ordinary tool calls or create memory files in the repository.

Build this as new `session-memory` extension and `session_memory` tool. Old `working-memory` code is not its implementation base. Remove old extension at final cutover; do not run both together or provide compatibility alias.

## Terms

- **Session:** Pi session containing user input, agent runs, branches, and persisted extension state.
- **Agent run:** Work started by a user prompt and continued until the agent stops.
- **Turn:** One model response and its tool calls. An agent run can contain many turns.
- **Checkpoint span:** Work between two session-memory checkpoints. A checkpoint can occur during an agent run.

## Session state

### Goal

One user-owned description of the outcome and important constraints. All memory, objectives, tasks, and files are managed in service of this goal.

The agent cannot silently change the goal. It may propose a change, but changing the stored goal requires user input or explicit approval. The user can redirect the goal during a session.

### Active objective

One agent-owned sub-goal describing the current focus. The agent may replace it whenever new evidence changes the best route toward the goal.

### Tasks

A small agent-owned working set of concrete tasks supporting the active objective. Tasks are disposable plans rather than a fixed checklist. The agent may add, reorder, split, replace, or abandon them as work develops.

Completed tasks disappear. Their useful result becomes memory. Failed approaches also disappear unless remembering the failure would prevent expensive repetition.

### Memories

Memories are plain statements containing the minimum sufficient detail needed to avoid rediscovery. A simple preference may be one sentence. An SDK rule may need a signature, usage sequence, and constraints. Length follows what future work requires.

There are two lifetimes:

- **Carry memory:** New memory that survives one checkpoint. At the following checkpoint it must be promoted or it expires.
- **Durable memory:** Promoted memory that survives checkpoints until the agent explicitly forgets it.

This gives new information one complete checkpoint span before the agent must decide whether it remains useful. The extension tracks age; the statements themselves stay simple.

### File working set

Files retain the existing tiers:

- **Read:** Exact source needed in the next span.
- **Outline:** Structure and symbol locations are enough.
- **Deferred:** Inactive path with a concrete condition for reconsidering it.

The agent reconciles these at checkpoints. Files that no longer have a realistic relevance condition leave memory entirely; deferred is not permanent storage.

## Widget prototype

Status: approved visual direction.

The persistent widget sits above the editor and keeps goal and active objective visible. Tasks, memories, and files live in tabs so the default view stays short. Tab labels carry counts; memory and file rows retain their lifetime or tier labels instead of collapsing everything into one list.

The Tool Preview prototype uses this shape:

- Fixed header: goal, active objective, checkpoint number, active token count, and last update time.
- Tasks: current agent-owned working set, with active task emphasized.
- Memories: carry and durable groups, including the carry-expiry rule.
- Files: read, outline, and deferred groups, with the deferred reconsideration condition.
- The preview stacks three static renders so tasks, memories, and files can be reviewed without taking editor input. Escape hides it.

Keep widget copy terse: render session state and controls without explanatory descriptions of the state model.

Run `/session-memory` to cycle tasks, memories, files, and hidden state. The widget never takes editor input.

When the production widget is built, replace the bespoke Tool Preview component with the real widget rendered against fixture state. Keep the three static selected-tab renders for visual review, and delete the duplicate preview implementation.

## Agent tool

`session_memory` is available throughout the session with two actions:

- **Update:** Change objective, tasks, memories, and file tiers without pruning context.
- **Checkpoint:** Request an early checkpoint at a coherent phase boundary.

A voluntary checkpoint requires at least one successful update in the current checkpoint span. The agent may checkpoint early, but the extension never depends on it choosing to do so.

Goal changes use a separate approval path within the tool. Ordinary memory and task management do not require approval.

## Fixed token gates

Gates use token counts, not percentages. Exact defaults remain undecided. The intended progression is:

1. **Memory reminder:** Ask the agent to record anything expensive to rediscover and remove stale state.
2. **Checkpoint warning:** Tell the agent a checkpoint is approaching and that carry memories, tasks, and files need review.
3. **Required checkpoint:** Trigger early enough to leave a fixed reserve below the configured context ceiling.

For example, a 150,000-token ceiling might use reminders around 50,000 and 100,000, then enter required-checkpoint mode at the ceiling minus a fixed checkpoint reserve.

## Required-checkpoint flow

1. Extension marks a checkpoint pending.
2. Extension appends a steering message telling the agent to perform a final memory update.
3. All tool definitions remain visible and unchanged.
4. Pi's pre-execution `tool_call` hook blocks every tool except `session_memory` with a short deterministic reason.
5. Agent reconciles goal-related memory, objective, tasks, and file tiers through `session_memory`.
6. Extension automatically checkpoints after the successful update. Agent choice is not required.
7. Gate clears only after the new context projection takes effect. Sibling tool calls from the checkpointing turn remain blocked.

If the agent responds without updating memory, the extension repeats the instruction. Emergency Pi compaction remains the final fallback rather than the normal path.

## Context after checkpoint

The next model request contains:

- Stable system and developer instructions.
- Approved goal.
- Active objective and current tasks.
- Durable memories.
- Carry memories still within their grace span.
- Requested file reads and outlines, plus cheap deferred reminders.
- Messages created after the checkpoint boundary.

Earlier user messages, assistant messages, tool calls, and tool results do not need to remain once their required meaning has been represented in this state.

## Cache behavior

Tool availability, schemas, descriptions, and prompt guidelines stay stable. Required-checkpoint enforcement blocks execution instead of hiding tools.

Normal memory updates append at the current conversation tail. They should not repeatedly rewrite an early context projection and invalidate the stable prefix. A checkpoint is the intentional boundary where the projected state and following context change.

Implementation must test consecutive final provider requests, including ordinary updates, a required checkpoint, and the first request after it.

## Subagents

Research and broad exploration should be delegated when isolation saves parent context. The parent asks for memory-ready output: only statements needed to continue, with exact technical detail where losing it would force another lookup. Research process and bulk source text stay in the child.

Useful child findings enter carry memory. The parent reads original material only when the child reports uncertainty or missing information.

## Technical plan

Implementation decisions, state schema, lifecycle, migration, and test slices live in
[`session-memory-redesign.technical.md`](./session-memory-redesign.technical.md).

## Production decision

`/session-memory` owns tab switching and hide/show behavior so the above-editor widget never steals editor keys.
