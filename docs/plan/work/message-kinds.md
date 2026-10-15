# What the model sees, what the user sees (considering, 2026-10-15)

Aligns the names and the rendering of everything in a chat, through compaction. Decided 2026-10-15: the wrapper is `reminder`. Built: the wrapper, the base-prompt section, the `update` rename, and the self-contained references update. Not built: folding earlier updates into the system prompt at a checkpoint. A saved update is a change text ("X changed. It now says…"), not a value, so a fold needs the sources to render the current values again; until then a checkpoint re-sends the updates as one `instructions` reminder.

## Inventory

"Model" means it reaches the model. "Chat" means the user sees it in the chat. "UI only" means state shown outside the chat.

| Kind | Stored as | Model | Chat | Notes |
| --- | --- | --- | --- | --- |
| Base prompt | code | system prompt | no | Fixed per release |
| Instructions, first | `instructions` entry, placement `system` | system prompt | no | AGENTS.md files, date, skills list, references |
| Instructions, later | `instructions` entry, placement `note` | user-role message at that point | no | One entry per change; unlabeled today |
| Tool definitions | code | tools | no | Unchanged between checkpoints |
| User prompt, steering | `user` entry | user message | yes | |
| Assistant reply | `assistant` entry | assistant message | yes | Interrupted replies are left out of later calls |
| Tool call started | `tool-started` entry | no | tool row | Stops a cut-short call from running again |
| Tool result | `tool-result` entry | tool message | tool row | |
| Nudge | `nudge` entry | user-role message at that point | no | Context stages, process exits; unlabeled today |
| Checks report | `checks` entry | user-role message, failures only | no | Unlabeled today |
| Run failed | `run-failed` entry | user-role message | yes | Unlabeled today |
| Attached references | `references` entry | only through the instructions source | sidebar | State, not a message |
| Background notes and memory | `note`, `memory` tables | after a checkpoint, as the summary prefix | no | Replace old entries in the view |
| Checkpoint handoff | `tool-result` details | after a checkpoint, a user-role message | tool row | |
| Notices, status, process list, usage | events | no | UI only | Not stored |

## Through compaction (as built)

After a checkpoint the view is: summary prefix (memory and notes), one message re-sending every earlier "later instructions" entry, the raw entries from the tail, then the handoff message. The architecture says the system prompt renders the values as of the last compaction and the notes then disappear. The built view re-sends them instead.

## Findings

1. Instruction updates, nudges, checks reports and run failures all become plain user messages. The model cannot tell them from the user's words.
2. "note" means two things: the background note table, and a later instructions entry (placement `note`).

## Proposal

- Wrap every hidden harness-written user-role message in `<reminder kind="...">…</reminder>`. Kinds: `instructions`, `nudge`, `checks`, `run-failed`, `handoff`. One base-prompt line says these come from the harness and are not the user's words.
- Rename placement `note` to `update`, so "note" means only background notes.
- Fold earlier instruction updates into the system prompt at a checkpoint, as the architecture says.
- Cost: existing sessions change their cached prefix once.

## Vocabulary alignment (proposed 2026-10-15, not agreed)

**Reminder** is the one word for any hidden message the harness writes into the context. It is user-role, wrapped in `<reminder kind="...">`, and the chat does not show it. Its kinds:

| Kind | Meaning | Saved as |
| --- | --- | --- |
| instructions | an instruction changed after the first message (an update) | `instructions` entry, placement `update` |
| nudge | Tau asks the model to act: a context-stage warning, a process exit notice | `nudge` entry |
| checks | the project checks failed | `checks` entry |
| run-failed | the previous run failed | `run-failed` entry |
| handoff | the agent's own checkpoint handoff, shown again after the checkpoint | tool result, re-wrapped in the view |

So a nudge is a kind of reminder, not a separate thing. Not wrapped yet: session memory and notes (`textMessage` in notes/view.ts). Open: wrap them as kinds `memory` and `notes`.

**Message** is anything the model receives on one call. Roles: system prompt, user, assistant, tool result. A prompt, a steering message and a follow-up are user messages the user wrote; everything hidden is a reminder.

**Seen by the user** (chat): prompts, steering messages, assistant replies, tool calls and results, run-ended. **UI only** (events, never sent to the model): references-changed, check progress, process status, the sidebar.

**Fold** has two meanings and needs one. Compaction.md uses it for the background job that merges old notes into session memory. The checkpoint idea here is to render the current instruction values into the system prompt and drop the old updates. Proposal: keep "fold" only for the second; call the first "merge".

## Vocabulary agreed 2026-10-15

Fold and merge: "fold" means putting current instruction values into the system prompt at a checkpoint (not built); "merge" is the background job that combines older short-term memory into long-term memory.

Memory language replaces "notes" and "memory": working memory is the context; short-term memory is the old notes (summaries of entry ranges); long-term memory is the old memory snapshot, per session only, for long sessions with several compactions. Entries are the raw log, not memory. Built: both are sent as reminders of kinds `short-term-memory` and `long-term-memory`. Built 2026-10-15: the rename. Tables are `short_term_memory` and `long_term_memory`; a checkpoint's details use `shortTerm`, `shortTermTokens` and `longTerm`; the service is `Memories` in `src/session/Memories.ts`; the folder is `src/core/internal/context/memory/`. Left as they were: local variable and field names that still say `notes`, and the stale "as a note" test names.
