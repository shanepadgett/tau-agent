# Context

Context stores reusable repository work scopes in `.pi/contexts`. Folder names become selector tabs, TOML files become concepts, and TOML sections become selectable entries.

Use `/context` to select entries. Entry `files` are injected through Tau autoread. Entry `anchors` supply lazy navigation paths that the agent can grep or read in ranges when needed.

After meaningful uncommitted work (new/moved ownership, not trivial already-covered polish), the coding agent should run the `context-sync` subagent so `.pi/contexts` stays aligned. Humans can also run `/context-sync` or `/context-sync <nudge>` and press Escape to cancel a running sync. It walks domain → concept → entry → membership, edits only `.pi/contexts` with `patch`, and the harness verifies write scope plus catalog invariants afterward. Out-of-scope writes are restored and the run fails. Optional nudge text soft-steers judgment without skipping evidence.

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
files = ["src/player/input.ts"]

[movement]
description = "Player locomotion and collision"
files = ["src/player/movement.ts"]
anchors = ["src/runtime/fetch-handler.ts"]
```

For example, `.pi/contexts/gameplay/player.toml` appears in the `gameplay` tab as the `Player` concept with `input` and `movement` entries. When `movement` is selected, Tau autoreads `src/player/movement.ts` and lists `src/runtime/fetch-handler.ts` as an unloaded anchor. If one selected entry marks a path as a file and another marks it as an anchor, autoread wins.
