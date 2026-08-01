# Context

Context stores reusable repository work scopes in `.pi/contexts`. Domain folders use `NN_slug` (`01_extensions`, `02_core`, …) so `/context` can order tabs; the UI shows the slug only. TOML files become concepts, and TOML sections become selectable entries.

See [Context management](../../docs/context.md) for catalog structure and taxonomy guidance.

Use `/context` to inject entries into the conversation. Selecting entries reads `read` paths in full, resolves `show` targets to current declaration slices, outlines `outline` paths, and adds one hidden note listing `references` and instructing the agent to treat the injected material as current. Injection happens once, immediately, before your next prompt; nothing is rebuilt on later model calls. Prefer complete reads for bounded work files; use `show` for thin contracts from larger neighbors; reserve `outline` for large or noisy files.

After meaningful uncommitted work (new/moved ownership, not trivial already-covered polish), the coding agent should run the `context-sync` subagent so `.pi/contexts` stays aligned. Context sync catalogs durable code and long-lived documentation as **work packs** (job-shaped entries an agent can start from), not bare path indexes. Scratch pads, working plans, interviews, rough ideas, and other temporary artifacts should stay out; add recurring transient paths to `validation.ignoreGlobs`. Humans can also run `/context-sync` or `/context-sync <nudge>`; the command replaces the editor with a status panel (Escape / Ctrl+C cancel). It uses normal repo tools, walks domain → concept → entry → start-pack modes, and prefers `patch` under `.pi/contexts`. The harness verifies catalog coverage afterward. Optional nudge text soft-steers judgment (including quality rewrites of weak bags) without skipping the ladder or coverage.

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
