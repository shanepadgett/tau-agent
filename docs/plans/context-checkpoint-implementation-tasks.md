# Context Checkpoint Implementation Tasks

- [x] Add ranged file injection.
  - [x] Preserve explicit ranges exactly.
  - [x] Preserve existing `auto` read/outline behavior.
  - [x] Add range metadata to injected file messages.
  - [ ] Expand coverage for full, outline, auto-large, disjoint, large-file, and oversized-range cases.

- [x] Implement the checkpoint tool.
  - [x] Accept retained message IDs, work, facts, decisions, and file directives.
  - [x] Preserve selected message text in the result text without retaining thinking or tool calls.
  - [x] Render deferred files in the result text.
  - [x] Call `injectFiles()` only for active reads and outlines.
  - [x] Return one tool result; do not send a separate checkpoint message.
- [x] Add stable hidden provider-context message ID metadata through Pi's `context` event.

- [x] Implement context replacement.
  - [x] Track checkpoint-owned file batches.
  - [x] Retain the current checkpoint tool-call/result pair, current file messages, and hidden continuation instruction.
  - [x] Remove older checkpoint batches and unselected history from the next provider request.
  - [x] Leave persisted session history intact.
  - [x] Fail closed when provider messages cannot be correlated with session entries.
  - [ ] Test consecutive checkpoints and request-cache stability.

- [ ] Add TUI visibility controls.
  - [x] Add a Tau setting, hidden by default.
  - [x] Gate checkpoint renderers dynamically and omit hidden continuity file messages from the chat mount.
  - [x] Show a short preview and Pi's configured expand hint when enabled.
  - [x] Show more of the same content when expanded.

- [x] Handle lifecycle cases.
  - [x] Reload with debug visibility enabled.
  - [x] Branching and existing compaction through active-branch context projection.
  - [x] Preserve per-file failure behavior and cancellation without a continuation.
  - [x] Empty checkpoint sections.
  - [x] Deferred files becoming active later.

- [ ] Add regression coverage for checkpoint text, message ordering, pruning, current-batch retention, and TUI visibility.

- [x] Update the continuity README and Tau help for row visibility settings.
