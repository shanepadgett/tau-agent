# Context Checkpoint Model

## Goal

Give long-running Pi sessions a rolling working context that can replace raw conversation and tool history without asking the model to summarize an entire transcript.

## Product decisions

- The chat is a stream of user messages, agent messages, tool calls, and tool results.
- A checkpoint produces the next active context block. It replaces the previous checkpoint block and retires older unselected context.
- Retained user and agent messages stay exact. The agent selects the messages that still define the work.
- The current user message and active user requirements remain protected.
- The checkpoint carries four text sections:
  - `work`: an ordered list of plain strings; the first item is the next thing to do. Completed items disappear on later checkpoints.
  - `facts`: concrete findings extracted from tools or exploration.
  - `decisions`: choices that should continue to govern the work.
  - `deferredFiles`: files and conditions that may require future inspection.
- Work items do not need IDs or a separate task system. A separate task system can be considered later if tasks need independent operations, dependencies, parallel ownership, or a user-facing view.
- There is no recall tool. The agent continues from the checkpoint itself.
- Raw tool results are disposable after their useful findings have been recorded. Derived findings from scripts, searches, web research, and complex data analysis must be captured as facts before pruning.

## File context

File content is live repository state and should be regenerated rather than copied into checkpoint text.

The checkpoint carries file directives with three modes:

- `read`: reread the file, optionally using specified ranges.
- `outline`: regenerate the file outline.
- `deferred`: keep only the path and a human-readable condition for loading it later.

Read and outline directives are system metadata. After the checkpoint, the context projection fulfills them and injects current results into active context. Those results do not render inside the checkpoint block.

Deferred files render in the checkpoint so the agent can recognize when to promote them to normal read or outline behavior.

The repository remains authoritative for current files. Facts preserve conclusions from earlier inspection; they do not replace the current source.

## Current implementation findings

- `packages/agent/extensions/explore/ast/read/hook.ts` replaces successful full reads of registered large source files with outlines. Explicit ranged reads already bypass that substitution.
- `packages/agent/shared/autoread.ts` currently accepts only complete file paths and emits visible `tau.autoread` messages through `pi.sendMessage()`. These messages are ordinary conversation history and are not replayed after compaction.
- `packages/agent/extensions/explore/read/autoread.ts` applies the same large-file outline policy to autoread, but has no range path.
- `packages/agent/extensions/context/projection.ts` already rebuilds current complete reads and outlines before model calls, removes the previous projection, and injects one ephemeral projection message.
- Current `.pi/contexts` selections persist full `read`, full `outline`, and unloaded `references` by branch-local entry ID. They do not represent checkpoint-specific ranges or deferred conditions.
- The outline injection provider already regenerates current outlines from paths and needs little conceptual change.

The checkpoint file directives should feed the projection machinery rather than become ordinary autoread conversation messages. They should remain separate from the durable `.pi/contexts` catalog because they are session-local and dynamic.

## Rough interaction

The system nudges the agent after enough context has accumulated or a meaningful work milestone has passed. The agent calls one checkpoint tool with:

```text
checkpoint({
  keepMessages,
  work,
  facts,
  decisions,
  files
})
```

The rough `files` payload is:

```text
files: [
  { path, mode: "read", ranges },
  { path, mode: "outline" },
  { path, mode: "deferred", when }
]
```

The system then:

1. Builds a new block from selected exact messages and the current text state.
2. Retains active file directives as system metadata.
3. Regenerates requested reads and outlines from the current repository.
4. Injects those current results through the ephemeral context projection.
5. Leaves deferred files in the rendered block.
6. Removes older unselected messages and raw tool results from active context.

## Immediate Explore changes

- Extend autoread requests and preparation to support explicit line ranges.
- Keep explicit ranged autoreads exact; do not replace them with a large-file outline.
- Preserve the existing full-autoread behavior for small files and outline substitution for large files.
- Reuse the existing outline provider and projection lifecycle for checkpoint-driven outlines.
- Add projection support for dynamic ranged reads and deferred-file state without changing the repository context catalog yet.

Pi's built-in compaction remains an emergency fallback during initial development.

## Deliberately deferred design work

- Exact checkpoint tool schema and message reference format
- How the system decides when to nudge
- How line ranges behave after file edits
- Checkpoint completeness checks before pruning
- Storage and session-lifecycle details
