# Autoread technical

## References

- `.pi/extensions/tau-edit/index.ts:41-99` shows current `/tau-edit` command flow: select resources, prompt for description, ask references, read file content, emit `tau:context.snapshot`, and send a user message.
- `.pi/extensions/tau-edit/index.ts:167-218` shows current context building, snapshot content shape, and prompt text to preserve as hidden edit instructions minus prompt/reference pieces.
- `src/shared/events.ts:24-40` defines `tau:context.snapshot` and `tau:tool-row-state.set`; replace the snapshot event and rename row-state payload from `toolCallId` to `rowId`.
- `src/shared/tool-row-state.ts:8-45` is the row visual state store and pruned title formatter; keep this as the shared pruning mechanism.
- `src/extensions/explore/index.ts:8-11` creates the shared row-state store and registers explore tools; register autoread from the same extension and store.
- `src/extensions/explore/read.ts:53-56` shows normal tools passing Pi `context.toolCallId` into `formatToolRowTitle`.
- `.pi/extensions/tool-preview/widgets/autoread.ts:49-92` has the accepted row rendering shape: dim/success dot, `autoread` title, muted path, warning title when pruned.
- `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:1342-1360` documents `pi.sendMessage` and `deliverAs: "nextTurn"` for queued conversation context that does not trigger a turn.
- `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:2519-2535` documents custom message renderers.
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:304-315` documents Pi tool render `toolCallId`; this exists only for real Pi tool executions.
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:862-869` documents `registerMessageRenderer` and `sendMessage` types.

Read only these ranges first unless the current code changed or the implementation needs missing type details.

## Shape

Use custom messages, not fake Pi tool calls. Pi only gives `toolCallId` to real assistant-requested tool executions. Autoread is user/event driven, so it uses Tau row ids with the same row-state store.

Create one visible custom message per autoread file. The message content is the full file payload for the model. The renderer shows it as an autoread row in the conversation. Use `deliverAs: "nextTurn"` so `/tau-edit` prepares conversation context without starting a turn.

Create one hidden custom message for `/tau-edit` manifest/instructions. It is also delivered as `nextTurn` and does not render.

## Files

- `src/shared/events.ts`
  - Delete `tau:context.snapshot`.
  - Add `tau:autoread.requested`:
    - `source: "tau-edit"`
    - `title?: string`
    - `cwd: string`
    - `batchId: string`
    - `files: Array<{ path: string }>`
  - Change `tau:tool-row-state.set` payload from `{ toolCallId, state }` to `{ rowId, state }`.

- `src/shared/tool-row-state.ts`
  - Rename parameters and maps from `toolCallId` to `rowId`.
  - Keep `ToolRowVisualState = "pruned"`.
  - Keep `formatToolRowTitle(store, rowId, toolName, theme)` behavior.
  - Existing tools pass Pi `context.toolCallId` as the `rowId`.

- `src/extensions/explore/autoread.ts`
  - New focused file.
  - Export a registration function, e.g. `registerAutoread(pi: ExtensionAPI, rowState: ToolRowStateStore): void`.
  - Define custom message type constant, e.g. `tau.autoread`.
  - Listen for `tau:autoread.requested` with `onTauEvent`.
  - For each file path:
    - create a stable row id from `batchId` plus file index or `crypto.randomUUID()`;
    - set initial local row status to `reading`;
    - read `join(cwd, path)` as UTF-8;
    - send visible custom message with `pi.sendMessage({ customType, display: true, content, details: { rowId, path, cwd, source, batchId } }, { deliverAs: "nextTurn" })`;
    - set row status to `read` and invalidate/render through component state.
  - On read failure, send a visible custom message for that file with an error-shaped content/details only if useful to user; keep the row visible. Do not silently drop requested files.
  - Register `pi.registerMessageRenderer(customType, renderer)`.
  - Renderer returns a component equivalent to the preview row:
    - dot color from local status: `reading` => `dim`, otherwise `success`;
    - title from `formatToolRowTitle(rowState, rowId, "autoread", theme)`;
    - path in muted text;
    - expanded view may include file content below the row; collapsed view is just the row.
  - The renderer must call `rowState.watch(rowId, invalidate)` if the renderer context exposes invalidation for custom messages. If custom message renderer has no invalidation context, read row-state directly during render and rely on conversation redraw; do not add global polling.

- `src/extensions/explore/index.ts`
  - Import and call `registerAutoread(pi, rowState)` after creating `rowState`.
  - Keep existing tool registration.
  - `session_start` still clears `rowState`; also clear autoread local runtime state if the autoread module exposes cleanup.

- `src/extensions/explore/read.ts`, `find.ts`, `grep.ts`, `ls.ts`, `src/extensions/patch/render.ts`, and preview helpers using row state
  - Update calls/types for `rowId` rename only.
  - No rendering behavior change.

- `.pi/extensions/tau-edit/index.ts`
  - Remove `promptForDescription`, `pickReferences`, `referenceLines`, and `SnapshotFile` flow if no longer used.
  - Keep resource discovery and selection UI.
  - Replace `buildContext` with a shape that returns:
    - `manifest: string`
    - `files: Array<{ path: string }>`
  - Do not read selected file contents in tau-edit.
  - Do not call `pi.sendUserMessage`.
  - Do not ask for prompt or references.
  - After selection:
    - build manifest/instructions;
    - `pi.sendMessage({ customType: INJECTED_CONTEXT_TYPE or a tau-edit-specific hidden type, content: hiddenContext, display: false, details: { source: "tau-edit", title: "Tau edit context" } }, { deliverAs: "nextTurn" })`;
    - emit `tau:autoread.requested` with `source: "tau-edit"`, `cwd`, `batchId`, and selected resource file paths;
    - leave editor text unchanged/empty. Do not prefill.
  - Update command description away from “search memory snapshots”.

- `.pi/extensions/tool-preview/widgets/autoread.ts`
  - Optional small sync only if implementation naming diverges from preview. Do not redesign preview.

## Hidden context text

Build hidden context in this shape:

```md
# /tau-edit context

Autoread files are visible context items in this conversation.
Do not reread autoread files before answering questions or making changes.

Root files are pointers only. Read only when directly needed.

Root files:
- AGENTS.md
- package.json

Shared files are pointers only. Read only when directly needed.

Shared files:
- src/shared/events.ts
- src/shared/tool-row-state.ts

Selected resources:
- explore (tau-extension): src/extensions/explore
- tau-edit (local-extension): .pi/extensions/tau-edit
```

Selected resource metadata lists resource name, kind, and path. Do not list autoread files in hidden context; autoread rows already show files.

Remove prompt-specific pieces:

- no `Request:` block;
- no reference repo lines;
- no idea-specific cleanup instruction unless the new flow still has an idea source. Current selected-resource flow does not.

## Order

1. Rename row state key to `rowId` and update all call sites.
2. Replace event types in `src/shared/events.ts`.
3. Add autoread custom message renderer/runtime under `src/extensions/explore/autoread.ts`.
4. Register autoread from `src/extensions/explore/index.ts`.
5. Rework `.pi/extensions/tau-edit/index.ts` to emit hidden context plus autoread paths and stop auto-submitting.
6. Remove dead imports/types/helpers from tau-edit.
7. Grep for `tau:context.snapshot` and old `toolCallId` row-state event payloads; remove stale references.

## Avoid

- Do not implement autoread as a public LLM-callable tool unless separately requested.
- Do not add offset/limit/chunking/truncation hint behavior.
- Do not preserve `tau:context.snapshot` compatibility unless another current caller exists.
- Do not add a prompt/reference step back into `/tau-edit`.
- Do not prefill the editor.
