# Reference session attachments

Status: implemented; focused verification complete, awaiting live TUI verification and user confirmation.

## Agreed behavior

- Attachments belong to the active conversation branch. The on-disk reference library remains shared.
- `/reference` opens with the current attachments checked.
- Space toggles the draft selection; Enter saves the entire selection, including an empty selection; Escape cancels selection changes.
- Saving does not edit the composer or start an agent turn.
- The model receives reference names, absolute locations, and read-only, task-focused usage guidance through a named prompt section.
- Attachments survive compaction and reopening and follow conversation forks.

## Architecture

Modify the reference extension and expand the shared selectable list to support restoring selection. Reuse Pi session entries and Tau's existing prompt-source system; add no new context-injection system.

```text
/reference
  -> read latest attachment snapshot from the active branch
  -> showReferencePanel(initial attachments)
  -> cancel: return without saving attachment state
  -> save: append complete attachment snapshot with pi.appendEntry()

Soul before_agent_start
  -> collectPromptSources()
  -> references source, refresh: "append"
  -> read latest attachment snapshot from the active branch
  -> named references section
  -> Pi structured prompt reconciliation
```

Read the full active branch with `ctx.sessionManager.getBranch()`, including entries before its latest compaction. Do not read abandoned branches or depend on compaction summary text. Reading the current branch at each boundary avoids a second in-memory attachment cache and its restoration lifecycle.

## Code boundaries

Persist only stable attachment identity, not Git metadata:

```ts
interface ReferenceAttachment {
  name: string;
  path: string;
}

interface ReferenceAttachmentState {
  references: ReferenceAttachment[];
}
```

Use custom session entry type `tau.reference.attachments`. The latest valid snapshot wins; no snapshot means no attachments. An empty snapshot explicitly clears attachments. Validate stored data at the read boundary and order attachments deterministically by path.

- `packages/agent/extensions/reference/index.ts`: register the prompt source, read branch state for the command, pass initial attachments to the panel, and persist confirmed selections. Remove `buildReferenceDraft()` and its composer write.
- `packages/agent/extensions/reference/attachments.ts`: own attachment types, the session entry identifier, and validated branch-state reconstruction.
- `packages/agent/extensions/reference/panel.ts`: accept initial attachments, seed checked rows by absolute path, label Enter as save, and return empty selections as valid results. Keep draft selection through filtering and metadata refreshes. Git metadata remains panel-only.
- `packages/tui/src/selectable-list.ts`: add a required-argument `setSelection(ids: readonly string[]): void` method that selects matching item IDs and emits the existing selection callback. Call it after panel initialization; retain the existing selection behavior during `setItems()`.
- Update the reference README and `packages/agent/extensions/tau-help/help.md` for the new command behavior.

Keep existing clone, update, branch-switch, open, and confirmed disk-delete actions. Escape cancels attachment edits, not already completed filesystem actions. Missing attached locations remain checked rows, marked missing, through library refreshes. They can be unchecked and saved or cloned again. Do not run open, branch, or update operations on missing rows. Validate disk-delete targets against both the library root and the stored absolute path.

Follow Pi's session persistence lifecycle: a new chat is saved only after its first user or assistant message. Attachments selected in an empty chat are temporary until that first message; document this rather than forcing a session file or creating a synthetic turn.

## Prompt and cache behavior

The source uses key `reference/attachments`, section `references`, and `refresh: "append"`. Produce only names, paths, and fixed usage guidance; omit branch, dirty status, timestamps, and directory contents. Return an empty section when detached.

Identical attachment state must produce identical section text across consecutive requests. A changed selection takes effect at the next agent run through Pi's structured prompt updates; do not replace the leading system prompt or prepend request-local messages. After compaction, reconstruct the section from durable session entries.

## Verification

Use the existing Pi integration boundary and verify API availability at the declared supported minimum; no minimum increase is planned.

Do not add or update tests. After implementation, inspect the final serialized model request across unchanged calls, attachment changes, clearing, and compaction. Verify panel selection restoration, save/cancel behavior, composer preservation, session reopening, and branch isolation. Interactive extension verification requires the user to `/reload` first. Finish with repository checks and report any unverified interactive behavior.

### Completed focused verification

- Verified against installed Pi 1.1.0, the declared minimum, without introducing newer integration APIs.
- In-memory state verification covered stable prompt text, compaction restoration, explicit clearing, branch isolation, invalid saved data, and shared-list selection restoration.
- Captured final Anthropic and OpenAI request bodies locally, with network disabled, after the actual reference source, Soul hook, session projection, and provider serialization. Unchanged requests were identical; attachment changes affected only the references section before provider projection; clearing and compaction restoration worked. Native system-update models retained their leading system prefix; other models retained Pi's existing prompt-projection fallback.
- Ran the actual command and panel with simulated UI and disabled Git execution: checked selections restored, missing rows survived refresh, filtered-out selections saved, Escape discarded edits, empty save detached all, the composer stayed untouched, and rendered lines stayed within the available width.
- No test files, fixtures, or test-only production exports were added.

Live TUI behavior and reopening a disk-backed session still need verification after `/reload`.
