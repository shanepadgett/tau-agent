# Context

Context stores reusable repository work scopes in `.pi/contexts`. Folder names become selector tabs, TOML files become concepts, and TOML sections become selectable entries.

Use `/context` to select entries and inject their files through Tau autoread. Use `/context-manage <idea>` to start an isolated maintenance agent that researches the catalog, presents proposed operations for approval, accepts feedback, and applies only selected operations.

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
