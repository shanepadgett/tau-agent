# Context

Context stores reusable repository work scopes in `.pi/contexts`. Domain folders use `NN_slug` (`01_extensions`, `02_core`, …) so `/context` can order tabs; the UI shows the slug only. TOML files become concepts, and TOML sections become selectable entries.

See [Context management](../../docs/context.md) for catalog structure and taxonomy guidance.

Use `/context` to inject entries into the conversation. Selecting entries reads `read` paths in full, resolves `show` targets to current declaration slices, outlines `outline` paths, and adds one hidden note listing `references` and instructing the agent to treat the injected material as current. Injection happens once, immediately, before your next prompt; nothing is rebuilt on later model calls. Prefer complete reads for bounded work files; use `show` for thin contracts from larger neighbors; reserve `outline` for large or noisy files.

Edit `.pi/contexts` files to maintain the catalog. Keep entries as work packs for recurring jobs; leave scratch files and plans out of the catalog. `/context` reads current catalog files when opened.

```toml
name = "Player"
description = "Player-owned gameplay systems"

[input]
description = "Input mapping and command handling"
read = ["src/player/input.ts"]
show = []
outline = []
references = []

[movement]
description = "Player locomotion and collision"
read = ["src/player/movement.ts"]
show = [
  { path = "src/runtime/fetch-handler.ts", name = "handleFetch" },
]
outline = []
references = ["src/runtime/fetch-handler.ts"]
```

Every entry must declare all four loading arrays. `read` supplies exact complete contents, `show` resolves path+name declaration slices, `outline` asks Explore for structural outlines, and `references` lists unloaded paths. If selected entries classify the same path differently, precedence is `read`, then `show`, then `outline`, then `references`.
