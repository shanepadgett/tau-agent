# Tau Standalone

Status: eleven spikes complete on macOS; OpenTUI, PTYs and file finding also verified on Linux arm64. Layers, package layout, Effect, the AI layer, the turn loop, SQLite access, tooling, FFF and helper reuse are settled. Use unpatched FFF first; reconsider the tested native workaround if a ranking bug is opened.

Tau becomes its own coding agent, built from the ground up on this branch. It does not embed or depend on Pi. OpenCode and Pi are read-only references for learning which problems they solved and how; Tau writes its own code on its own architecture and copies none of theirs. Their published packages may be dependencies like any other, such as `@opencode/codemode` behind `run`. The `main` branch stays a Pi package and keeps shipping until this branch replaces it.

| File | Holds |
| --- | --- |
| [features.md](features.md) | What Tau does for the user and the model. |
| [architecture.md](architecture.md) | How it is built: runtime, layers, data model, build order. |
| [sdk.md](sdk.md) | The SDK's shape: one public face for extensions, four kinds of extension point, the scoped context, public types. |
| [sdk-packages.md](sdk-packages.md) | How extensions are packaged, installed, started and versioned. |
| [sdk-catalog.md](sdk-catalog.md) | What each SDK area offers, the replaceable runtime parts, the stable-prefix rules and the named UI places. |
| [tooling.md](tooling.md) | Checks, lint rules, and library choices. |
| [spikes.md](spikes.md) | Questions tested before building, with results. |
| [deferred.md](deferred.md) | Decisions to make later, and what brings each up. |
| [questions.md](questions.md) | Open questions for the user. |

## Status

Phase zero (check infrastructure) is complete; its decisions are in [tooling.md](tooling.md) and its unverified cases in [deferred.md](deferred.md). Build step 1 (SQLite service, credential store) shipped. Build step 2 (the AI layer: routes, logins, Sign in with ChatGPT, model catalog, OpenCode Go, structured output) is built and confirmed live; its lasting decisions are in [architecture.md](architecture.md#ai-layer). Next: build step 3, sessions.

SDK rounds 1–3 are agreed. Round 4 (isolation and trust) is planned before build step 7.
