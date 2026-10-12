# Tau Standalone

Status: spiking. Architecture not settled.

## Goal

Tau becomes its own coding agent, built from the ground up on this branch. It does not embed or depend on Pi. Pi's code (MIT) may be read and ported where that is faster, keeping its license notice.

The `main` branch stays a Pi package and keeps shipping until this branch replaces it.

## Agreed

- **Runtime:** Bun only. No Node fallback. Distributed as a compiled binary (`bun build --compile`).
- **Identity:** executable `tau`, global dir `~/.tau`, project dir `.tau/`. Tau never reads Pi's state.
- **Providers:** three wire protocols and two subscription logins.

  | Provider | Protocol | Login |
  | --- | --- | --- |
  | Anthropic | Anthropic Messages | Claude subscription OAuth |
  | OpenAI | OpenAI Responses | API key |
  | OpenAI Codex | OpenAI Responses | ChatGPT subscription OAuth |
  | OpenRouter | OpenAI Chat Completions | API key |
  | OpenCode Go | OpenAI Chat Completions | API key |

- **Decision models:** classification is a core AI capability next to chat, with structured questions and answers. Jev (via OpenRouter) and Luna (via OpenAI or OpenRouter) must work.
- **Modes:** interactive and print. No RPC. The UI and print mode are both clients of one core command and event interface, so RPC can be added later as a thin layer.
- **Sessions:** stored in SQLite (`bun:sqlite`). No import of Pi sessions.
- **Extensions:** no Pi compatibility. One SDK package for extension and package authors.
- **Extension model:** every core behavior is a named service that can be wrapped or replaced, and each service emits events around it. Examples: prompt submission, context building, model selection, tool execution, compaction.
- **Built-ins:** Tau's current extensions that belong in the product (decisions, routing, tool approval, compaction, footer, and others) become first-party services using the same service mechanism as third-party extensions, redesigned rather than ported as-is.
- **Responsiveness:** the submitted prompt appears in the chat immediately; slow work such as routing runs after and reports progress.

## Layers (draft)

```text
ai        providers, streaming, message format, logins, classify
core      agent loop, tools, cancellation, steering, services + events
sessions  SQLite storage, branching, compaction
host      settings, auth, extension/skill/prompt loading, AGENTS.md, trust
tui       renderer, components, interactive shell
cli       entry, print mode
sdk       public surface over all of the above
```

## Build order (draft)

1. AI layer, tested with small scripts.
2. Agent loop and core tools, driven by print mode.
3. Sessions and compaction.
4. TUI and interactive shell.
5. Extension host and SDK; port Tau's built-ins from `main`.
6. Settings, packages, install, and updates.

## Spikes

Each answers one question before the real build. Results go in `spikes/<name>/NOTES.md`.

1. **Extension loading in a compiled binary:** can a user's `.ts` extension import the SDK and resolve it to the copy embedded in the binary (for example with a runtime `Bun.plugin` resolver)?
2. **Reload:** can changed extensions be re-imported without restarting, bypassing Bun's module cache?
3. **WASM under `--compile`:** do ast-grep, tree-sitter, and QuickJS load from a compiled binary?
4. **TUI on Bun:** raw stdin, key input, resize, and differential rendering in a compiled binary.
5. **SQLite sessions:** schema for append-only entries with branching; write and load speed on a large session.
6. **Providers:** streaming plus prompt caching for each protocol, both subscription logins, and a classify call.
7. **Startup time:** cold start of a compiled binary that loads several extensions.

## Open

- Package and SDK names.
- Order of the spikes.
