# Extending Tau Agent

Tau Agent is a Pi extension harness. External integration uses Pi's native `pi.events` bus.

The caller and Tau Agent must be loaded in the same Pi runtime. External callers use string channel names and documented payloads. They do not import Tau Agent internals.

Only events documented in this file are public. Extensions run trusted in-process; event emitters can ask Tau Agent to do work.

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
