# Extending Tau Agent

Tau Agent is a Pi extension harness. External integration uses Pi's native `pi.events` bus.

The caller and Tau Agent must be loaded in the same Pi runtime. External callers use string channel names and documented payloads. They do not import Tau Agent internals.

Only events documented in this file are public. Extensions run trusted in-process; event emitters can ask Tau Agent to do work.

Related:

- [Custom subagents](./subagents.md)
- [TUI components](./tui.md)

## `tau:autoread.requested`

Ask Tau Agent to read files and inject visible `tau.autoread` messages.

```ts
pi.events.emit("tau:autoread.requested", {
  source: "my-extension",
  title: "Skill context",
  cwd: ctx.cwd,
  batchId,
  files: [{ path: "skills/foo/SKILL.md" }],
});
```

Fields:

- `source`: caller identifier shown in Tau metadata.
- `title`: optional display/context label.
- `cwd`: root used to resolve file paths.
- `batchId`: groups visible autoread messages.
- `files[].path`: file path relative to `cwd`.

Behavior:

- Tau reads each requested file.
- Tau injects visible `tau.autoread` messages.
- Missing or unreadable files produce visible failed autoread messages.
- `pi.events.emit(...)` does not return file contents and should not be treated as completion or ack.

## `tau:footer-item`

Publish a bottom-right footer item in Tau's status footer.

```ts
pi.events.emit("tau:footer-item", {
  id: "my-extension.status",
  text: "syncing",
  priority: 10,
});
```

Fields:

- `id`: stable item id. Re-emitting the same id replaces the previous item.
- `text`: optional display text. Omit or clear to remove the item (implementation may treat empty/undefined as hide).
- `priority`: optional sort priority (higher shows first when the footer ranks items).

## `tau:agent.blocked`

Notify that Tau is blocked waiting on the user (confirmations, custom UI, attention).

```ts
pi.events.emit("tau:agent.blocked", {
  source: "my-extension",
  title: "Needs input",
  body: "Answer the open question to continue.",
});
```

Fields:

- `source`: optional caller id.
- `title`: optional short title.
- `body`: optional detail text.

Tau's attention extension listens for this event. Other packages can listen too for custom notifications.

## `tau:file-mutation.applied`

Emitted after Tau's `patch` tool applies file changes.

```ts
pi.events.on("tau:file-mutation.applied", (data) => {
  // data.source === "patch"
  // data.status: "completed" | "partial" | "failed"
  // data.changes: path, kind, line stats, optional move/snapshotRanges
});
```

Fields:

- `source`: currently `"patch"`.
- `toolCallId`: tool call that produced the mutation.
- `cwd`: working directory for the tool call.
- `status`: overall result.
- `changes[]`: per-file change summary (`path`, `kind`, optional `move`, `linesAdded`, `linesRemoved`, optional `snapshotRanges`).

Use this to react after mutations (formatters, review hooks, status UI). Do not treat it as a request channel.

## `tau:tool-row-state.set`

Set visual state on a Tau tool row (for example pruned).

```ts
pi.events.emit("tau:tool-row-state.set", {
  rowId: "some-row-id",
  state: "pruned",
});
```

Fields:

- `rowId`: tool row id.
- `state`: optional visual state. Omit to clear.

Most extenders do not need this; it is for coordinating tool-row rendering with Tau's explore/patch/subagent tooling.
