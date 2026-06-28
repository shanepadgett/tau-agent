# Conversation Management Spec

## Ownership

- The system shall provide one focus extension for active goal, follow-up goal, parked ideas, focus memory, and compaction policy.
- The system shall keep search as the owner of `read`, `grep`, `find`, `ls`, search tool rendering, search evidence metadata, and read coverage enforcement.
- The system shall expose focus as the single public working-memory system.

## Goal Lifecycle

- When a new session receives its first user prompt, the system shall derive a terse candidate goal before the first agent response.
- When a candidate goal is derived, the system shall show an approval UI that lets the user approve, edit, or provide feedback for regeneration.
- When the user accepts a goal, the system shall persist the accepted goal as explicit focus state and insert a visible goal event after the user prompt and before the first agent response.
- The system shall maintain exactly one active goal and may maintain one follow-up goal.
- When the active goal changes, the system shall record the change through explicit focus state and a visible goal event.
- When the agent believes the active goal is complete, it should ask the user in normal chat whether to finish the goal.
- When the user confirms goal completion, the agent shall use the focus tool to finish the goal.
- When a follow-up goal exists and the active goal is finished, the focus tool may promote the follow-up goal to active.

## Goal UI

- The system shall show the active goal in a persistent widget above the editor.
- When a follow-up goal exists, the system shall show it in the persistent goal widget with weaker emphasis than the active goal.
- The system shall show goal set, update, completion, and promotion events as visible custom-rendered chat messages.

## Ideas

- The focus extension shall own parked ideas.
- The system shall keep `/ideas` available as a user command.
- The focus tool shall allow the agent to log a parked idea.
- When a new user thread is off-track from the active goal, the agent should prefer parking it as an idea over making it an in-session follow-up goal.

## Focus Tool

- The system shall expose one agent-facing `focus` tool for focus memory management.
- The focus tool shall replace or fold in the current public `forget` memory behavior.
- The focus tool shall allow the agent to mark files and ranges relevant, irrelevant, or done.
- The focus tool shall allow the agent to store a terse checkpoint and may allow the agent to store an explicit next action.
- The focus tool shall support goal updates, goal completion, follow-up promotion, and idea logging.
- The focus tool shall record facts from explicit user input, explicit agent input, or structured search evidence.

## Search Evidence and Read Coverage

- Search shall emit structured evidence metadata for search tool results.
- Focus shall consume structured search evidence metadata for relevance state and compaction policy.
- Search shall track read coverage for file ranges read since the last modification of each file.
- When an unchanged file range is already covered by prior read coverage, search shall hard-deny another read of that range.
- When search denies a reread, it shall return a terse reason and prior coverage evidence.
- When a file is modified, search shall invalidate prior read coverage for that file.

## Compaction Preflight

- When compaction is requested and focus state is sufficient, the system shall compact automatically.
- When compaction is requested and no focus-memory checkpoint exists and no concrete repo or tool state needs preservation, the system shall trigger a narrow agent turn instead of compacting immediately.
- When the system triggers a focus-cleanup agent turn, it shall ask the agent to use the focus tool to mark current working memory as relevant, irrelevant, or done.
- When the required focus tool call completes during a focus-cleanup turn, the system shall compact automatically at the end of that agent turn.

## Compaction Summary

- The compaction summary shall be structured sections rather than a prose blob.
- The compaction summary shall include the active goal and, when present, the follow-up goal.
- The compaction summary shall include relevant files and ranges, irrelevant files and ranges, and files touched from focus state.
- When an explicit checkpoint exists, the compaction summary shall include it.
- When an explicit next action exists, the compaction summary shall include it.
- The compaction summary shall include the last two user and assistant message pairs and omit tool calls between those pairs.
- The compactor shall cull or stub bulk navigation evidence from `find`, `ls`, and `grep` unless focus state explicitly retains it.
- The compactor may carry forward relevant complete reads as active evidence.
- The compactor shall represent irrelevant reads as path or range warnings rather than full content.
- When multiple compactions stack, the system shall merge older compaction summaries into the new focus summary instead of preserving multiple stale summaries.
- While the active goal is unchanged, the system shall carry forward irrelevant-file memory.
- When the active goal changes, the system may drop irrelevant-file memory unless explicitly retained.
