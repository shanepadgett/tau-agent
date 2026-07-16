# Context

Context stores reusable repository work scopes in `.pi/contexts`. Folder names become selector tabs, TOML files become concepts, and TOML sections become selectable entries.

Use `/context` to select entries. Entry `files` are injected through Tau autoread. Entry `anchors` supply lazy navigation paths that the agent can grep or read in ranges when needed. Use `/context-sync` to reconcile affected scopes from the current Git changes. Tau validates both file classes as context membership after agent turns and asks the agent to sync uncovered changed files or stale references automatically.

Validation is disabled by default. Enable it globally or per project in Tau settings:

```json
{
  "extensions": {
    "context": {
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
