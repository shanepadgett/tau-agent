# Vocabulary

## Runtime flow

**Session:** Saved chat file and runtime state for one conversation.

**User prompt:** One human message. Starts an agent run.

**Agent run:** All agent work caused by one user prompt, until the agent is done.

**Agent turn:** One model response cycle inside an agent run: model response plus any tool calls from that response.

**Final assistant message:** Assistant response that ends an agent run. Usually has no tool calls.

## Tools

**Tool call:** One model request to run a tool, such as `read`, `grep`, `find`, or `bash`.

**Tool batch:** Multiple tool calls requested by one model response. Counts as one agent turn.

**Tool result:** Output from one tool call, added back into context for the model.

## Context

**Context:** Messages and instructions sent to the model for one model call.

**Hidden custom message:** Context message the model sees but the TUI does not show as normal chat.

**Visible custom message:** Custom message shown in the TUI. May also become session history.

## TUI

**TUI component:** Renderable terminal UI object from `@earendil-works/pi-tui`, such as `Text`, `Box`, or `Container`.

**ToolExecutionComponent:** Pi's built-in UI component for a tool execution row. Uses `renderCall` and `renderResult` for custom slots.

**Cursor:** The current row position in a picker or list. Usually shown with a highlight and/or leading pointer. Say “cursor” for the active row, not “selector.”

**Pointer:** The visible marker next to the cursor row, often `>`.

**Selection:** A chosen item state, usually shown separately from the cursor with a checkbox like `[x]`.
