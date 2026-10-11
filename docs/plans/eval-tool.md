# Eval tool

Status: implemented; live extension validation requires the user's `/reload`.

## Direction

Provide the tool as Eval, remove its Deno runtime, and adopt Pi write-tool call previews. Keep Python 3 and Node.js, including Node's erasable TypeScript support. Preserve failed-script patch retries. Pi owns tool orchestration through codemode; Eval runs local code.

Agreed: keep fresh-process execution per call. The user selected this option with Deno removal, repository-wide Eval naming, and Pi-style bounded code previews included in the scope.

## Architecture

Modify the existing execution extension; rename its directory to `packages/agent/extensions/eval/`. No new execution system is required for the recommended first change.

```text
model or Pi codemode -> eval call
  -> tool-approval -> source store resolves full source and approves exact request
  -> eval verifies approval -> source store resolves new source or retry edits
  -> temporary source file -> fresh Python/Node process in project cwd
  -> shared bounded text-result builder -> session output store
  -> tool result

streaming call arguments -> Eval call renderer -> Pi Text component
tool result -> existing output preview renderer -> Pi Text component
```

The source store remains the shared boundary between approval and execution. Rename its private event to `tau:eval.source-store` and update both sides together. Preserve the existing source-inspection rules, approval invalidation, timeout, cancellation, failure storage, output bounds, and session cleanup.

Removing a supported Deno runtime does not remove approval detection of `deno` invoked through bash; that is security inspection, not runtime support.

## Tool contract

```ts
type Language = "python3" | "node";

// Existing request shape, with only the runtime set and tool name changed.
type EvalRequest = {
  language: Language;
  script?: string;
  scriptId?: string;
  edits?: Array<{ oldText: string; newText: string }>;
};
```

New runs provide `script`; retries provide `scriptId` and `edits`. Source resolution must produce identical source for approval and execution. Keep `scriptId`, `script`, and generic script-source terminology: these describe the data, not the obsolete tool name.

## Call renderer

Pi 1.1.0's `dist/core/tools/renderers/write.js` shows the first 10 source lines when collapsed, trims trailing empty lines, syntax-highlights code, and appends `... (N more lines, M total, <current expand binding> to expand)`. Its `renderCall` uses `context.expanded` while arguments are arriving, and reuses `context.lastComponent`. It also maintains an incremental highlighting cache for longer input.

Apply that presentation to Eval:

- Header: `eval python3` or `eval node (Node.js)`.
- New source: syntax-highlight Python or TypeScript rather than bolding the whole script.
- Collapsed call: show the first 10 source lines and the same remaining/total line footer throughout argument streaming and after completion.
- Expanded call: show all received source.
- Retry call: preserve red removed lines and green added lines; apply one combined 10-line preview limit across all edits.
- Use `keyHint("app.tools.expand", "to expand")`, not a literal shortcut.
- Keep input and output overflow counts separate. During streaming, show the shortcut with the input count. For completed calls, show it once at the end of the result: use the output preview's hint when output is truncated, or append it when only input is truncated. Expanded calls show no expansion hint. Share input-overflow state through Pi's typed renderer context; expose truncation metadata from the shared output preview instead of copying its line limit.
- Handle incomplete language, script, and edit fields during streaming. Reuse Pi's `Text` component and exported highlighting functions; highlight only the visible source prefix when collapsed rather than copying Pi's full cache implementation.

These are source-line limits like Pi write, not terminal-row limits; long source lines can wrap. Results retain their existing preview limit and automatic expansion on errors. After visual validation, the user requested a clearer input/result boundary: add a muted Output or Error divider with a blank line above and below it in `renderResult`. Partial results stay hidden. This presentation changes no model-visible content.

## Repository wiring

Update tool name, label, extension factory name, private event/subscriber IDs, temporary directory prefix, and source-store error messages. Remove Deno discovery, schema values, invocation branches, and runtime guidance.

Update tool-approval routing, evidence descriptions, source-store event types, silent-command-runner tracking and generated guidance, Soul prompt guidance, AGENTS.md, root README, extension READMEs, Tau Help, and `.pi/contexts` entries. Rename the extension context file to `eval.toml` and update active plan references. Scan tracked and project-context files for stale tool names. No old-name alias is proposed.

## Compatibility and cache safety

The declared Pi minimum is 1.1.0. Its exported highlighting APIs and renderer context already support this presentation; no minimum change is needed.

The rename and reduced runtime enum change serialized tool schemas and static prompt guidance once at reload. Keep the detected language list stable for the loaded extension. Rendering affects no model-visible request fields. Consecutive unchanged calls must retain identical tool declarations and prompt prefixes; do not insert script state, preview counts, or renderer status into those prefixes. Inspect the final tool declaration and generated Soul/check guidance together for stale names.

## Verification

Do not add or edit tests. Inspect both full-source and retry rendering paths, incomplete streaming arguments, expansion, and overflow counts. Verify that Eval still reaches approval and automatic post-write/check tracking. Run repository verification after implementation. Live extension validation requires the user's `/reload`.

## Execution state

Each call starts a fresh Python or Node process. Variables and imports do not persist between calls. Keep failed-script source storage for patch retries; this stores code, not runtime state.

## Follow-up check guidance

The user approved requiring `run_checks` only in runs that edit repository files. Update `formatCheckInstructions`, which supplies both the tool description and Soul's automatic-check guidance. Explicitly skip discussion, read-only investigation, and in-memory code execution without repository edits; a write-capable tool name alone is not an edit. Preserve stale-result invalidation and failure-repair requirements for file-editing runs, and preserve automatic selection of applicable checks. No new lifecycle state or tool-exposure changes are needed. The guidance stays static across read-only and file-editing turns, preserving the cached request prefix; renderer state never enters model requests.
