# Context

Context stores reusable repository work scopes in `.pi/contexts`. Folder names become selector tabs, TOML files become concepts, and TOML sections become selectable entries.

See [Context management](../../docs/context.md) for catalog structure and taxonomy guidance.

Use `/context` to set active entries for the current session branch. Tau stores only the selected entry IDs. Before each model call it rebuilds one ephemeral projection from current files, so repeated selections do not accumulate snapshots in conversation history. Open `/context`, press `Ctrl+C`, then confirm to clear active context.

After meaningful uncommitted work (new/moved ownership, not trivial already-covered polish), the coding agent should run the `context-sync` subagent so `.pi/contexts` stays aligned. Context sync catalogs durable code and long-lived documentation. Scratch pads, working plans, interviews, rough ideas, and other temporary artifacts should stay out; add recurring transient paths to `validation.ignoreGlobs`. Humans can also run `/context-sync` or `/context-sync <nudge>` and press Escape to cancel a running sync. It walks domain → concept → entry → membership, edits only `.pi/contexts` with `patch`, and the harness verifies write scope plus catalog invariants afterward. Out-of-scope writes are restored and the run fails. Optional nudge text soft-steers judgment without skipping evidence.

Sync surface is configurable:

- `sync.enabled` (default true) — master switch. Off: no `/context-sync`, parent cannot call `context-sync`, validation does not auto-run sync.
- `sync.automation` (default true) — when false with sync still enabled: manual `/context-sync` only (coding agent does not see context-sync). Validation auto-run still works if validation is enabled.
- `validation.enabled` (default false) — after agent turns, check membership and auto-run context-sync on failure (requires `sync.enabled`).

```json
{
  "extensions": {
    "context": {
      "sync": {
        "enabled": true,
        "automation": true
      },
      "validation": {
        "enabled": true,
        "ignoreGlobs": ["generated/**"]
      }
    }
  }
}
```

```toml
name = "Player"
description = "Player-owned gameplay systems"

[input]
description = "Input mapping and command handling"
read = []
outline = ["src/player/input.ts"]
references = []

[movement]
description = "Player locomotion and collision"
read = []
outline = ["src/player/movement.ts"]
references = ["src/runtime/fetch-handler.ts"]
```

Every entry must declare all three loading arrays. `read` supplies exact complete contents, `outline` asks Explore for current structural outlines, and `references` lists unloaded paths. If selected entries classify the same path differently, precedence is `read`, then `outline`, then `references`.
