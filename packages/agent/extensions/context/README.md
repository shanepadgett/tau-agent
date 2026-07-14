# Context

Context stores reusable repository work scopes in `.pi/contexts`. Folder names become selector tabs, TOML files become concepts, and TOML sections become selectable entries.

Use `/context` to select entries and inject their files through Tau autoread. Use `/context-sync` to reconcile affected scopes from the current Git changes. Tau validates context membership after agent turns and asks the agent to sync uncovered changed files or stale references automatically.

Validation is enabled by default. Configure it globally or per project in Tau settings:

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
```

For example, `.pi/contexts/gameplay/player.toml` appears in the `gameplay` tab as the `Player` concept with `input` and `movement` entries.
