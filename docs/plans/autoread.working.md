# Autoread working

Goal: replace tau-edit file snapshots with event-driven autoread rows and hidden edit context.

Current facts:
- `src/extensions/explore/index.ts` creates one `ToolRowStateStore` and registers `ls`, `find`, `grep`, `read`.
- `src/extensions/explore/read.ts` wraps Pi `createReadToolDefinition`, uses `formatToolRowTitle(rowState, context.toolCallId, "read", theme)`.
- `src/shared/tool-row-state.ts` stores visual state by `toolCallId`; only state is `"pruned"`; `formatToolRowTitle` colors tool name warning when pruned.
- `src/shared/events.ts` has `tau:context.snapshot`; name and payload are wrong for new behavior.
- `.pi/extensions/tau-edit/index.ts` currently selects resources, asks for prompt, asks references, reads all selected file content, emits `tau:context.snapshot`, then sends a user message.
- `.pi/extensions/tool-preview/widgets/autoread.ts` preview shape: gray dot while reading, green dot after read/pruned, tool name yellow when pruned, muted path args.
- Pi proper tool call ids are created by Pi only for assistant-requested tool calls. Autoread needs Tau synthetic row ids but should use same row-state store semantics.
- `src/shared/injected-context.ts` has hidden context message helpers, but current queue helpers have no active consumer found.

Settled:
- Autoread reads whole files. No offset/limit/chunk loop/truncation hint.
- Autoread is event-driven, not agent-called.
- Event carries paths, not file contents.
- `/tau-edit` should not ask for edit prompt and should not ask for references.
- `/tau-edit` should not auto-submit a user prompt.
- `/tau-edit` should prepare context, let user type in editor, and users can add references with existing reference tooling separately.
- Existing `tau:context.snapshot` should be replaced by an autoread event for this flow.
- Row state key should become honest: `rowId`, with Pi `toolCallId` passed as a row id for normal tools and synthetic ids for autoread.

Likely shape:
- Add `tau:autoread.requested` to `src/shared/events.ts` with source, cwd, batch id, files/paths.
- Add autoread runtime under `src/extensions/explore/`, registered from `explore/index.ts`.
- Runtime listens for autoread events, creates synthetic row ids, reads files, sends one visible custom message per file with `deliverAs: "nextTurn"`, and renders those messages as autoread rows.
- Rework tau-edit to build manifest/instructions as one hidden custom message with `deliverAs: "nextTurn"`, emit autoread paths, and leave the editor empty for the user to type.

Resolved:
- Hidden context and file content should be queued with `pi.sendMessage(..., { deliverAs: "nextTurn" })` as conversation context without starting a turn.
- Autoread rows should be visible custom messages in the conversation, rendered like tool rows.
- `/tau-edit` should leave the editor empty.
