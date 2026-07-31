# Context Checkpoint Model

## Goal

Give long-running Pi sessions a rolling working context that can replace raw conversation and tool history without asking the model to summarize an entire transcript.

## Product decisions

- The chat is a stream of user messages, agent messages, tool calls, and tool results.
- The checkpoint tool result is the next active context block. It replaces the previous checkpoint state and retires older unselected context.
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
- User and assistant session-entry IDs are exposed to the model through stable hidden provider-context metadata messages added by the continuity context handler. Checkpoint arguments retain IDs rather than copied message text; normal message content and TUI rows stay free of those IDs.

## File context

File content is live repository state and should be regenerated rather than copied into checkpoint text.

The checkpoint carries file directives with three modes:

- `read`: reread the file, optionally using specified ranges.
- `outline`: regenerate the file outline.
- `deferred`: keep only the path and a human-readable condition for loading it later.

Read and outline directives are system metadata. During checkpoint execution, the direct file-injection API fulfills them and adds current results as separate file messages. Those results do not render inside the checkpoint text.

Deferred files render in the checkpoint so the agent can recognize when to promote them to normal read or outline behavior.

The repository remains authoritative for current files. Facts preserve conclusions from earlier inspection; they do not replace the current source.

## Current implementation findings

- `packages/agent/extensions/explore/ast/read/hook.ts` replaces successful full reads of registered large source files with outlines. Explicit ranged reads already bypass that substitution.
- `packages/agent/src/file-injection/index.ts` now provides the direct injection seam:
  - `prepareFileInjection(request)` prepares file messages without sending them.
  - `injectFiles(pi, request)` prepares and sends them in order.
  - Current modes are `full`, `outline`, and `auto`; `auto` applies the Explore size threshold.
- `/context` uses `injectFiles()` for selected files and sends one separate hidden context brief. Handoff uses `prepareFileInjection()`.
- Explicit ranges are normalized, force a current read, and omit complete-file cache metadata. `FileInjectionFile` carries optional one-based inclusive ranges.
- Current `.pi/contexts` entries still describe durable full `read`, full `outline`, and unloaded `references`; checkpoint file directives are session-local and should remain separate.

The continuity checkpoint tool returns the conversation/work state through its own tool result. It accepts exact provider-visible session-entry IDs, resolves original messages from the active branch, and keeps only user text and assistant text blocks. It calls the direct file-injection API only for active file reads and outlines, then queues one hidden continuation instruction after those file messages. The continuation is an instruction, not a second checkpoint state message.

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

1. Builds the checkpoint tool result from selected exact messages and the current text state.
2. Records active file directives and a checkpoint-owned file batch.
3. Calls the direct file-injection API for requested reads and outlines.
4. Returns the text checkpoint result to the agent as the state block.
5. Leaves deferred files in that result and queues the hidden continuation instruction after active file messages.
6. Filters older unselected messages and raw tool results from the next provider context while retaining the checkpoint tool pair, current file batch, and continuation instruction.

## Immediate continuity changes

- Add the `continuity` extension with the `checkpoint` tool and make its result the continuation state.
- Add stable hidden `display: false` provider-context metadata messages through Pi's `context` event. Keep session history, normal message content, and TUI rows unmodified.
- Resolve selected IDs from active-branch session entries; automatically retain the latest user message and omit assistant thinking/tool-call blocks.
- Extend the direct file-injection API to support explicit line ranges.
- Keep explicit ranged reads exact; do not replace them with a large-file outline.
- Preserve `auto` behavior for small files and large-file outline substitution.
- Use a checkpoint-owned source and batch marker so prior checkpoint file messages can be filtered from active context.
- Keep deferred files in checkpoint text and load them only when their condition is met.
- Add a Tau setting that hides checkpoint and file-injection rows by default. When enabled and reloaded, show checkpoint and newly injected-file content with a short preview and Pi's configured expand hint; expanded output shows more of that content.
- Keep checkpoint/file messages model-visible even when their TUI rows are hidden. Set continuity file-message display at injection time so hidden rows are not mounted by Pi's custom-message wrapper; existing injected-file rows keep their saved display state.

Pi's built-in compaction remains an emergency fallback during initial development.

## Deliberately deferred design work

- How the system decides when to nudge
- How line ranges behave after file edits
- Checkpoint completeness checks before pruning
- Storage and session-lifecycle details
