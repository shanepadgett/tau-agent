# Tau Standalone

Status: eight spikes complete on macOS; OpenTUI, PTYs and file finding also verified on Linux arm64. Layers, package layout, Effect, the AI layer, the turn loop, SQLite access, tooling, FFF and helper reuse are settled. Use unpatched FFF first; reconsider the tested native workaround if a ranking bug is opened.

Tau becomes its own coding agent, built from the ground up on this branch. It does not embed or depend on Pi. OpenCode and Pi are read-only references for learning which problems they solved and how; Tau writes its own code on its own architecture and copies none of theirs. The `main` branch stays a Pi package and keeps shipping until this branch replaces it.

| File | Holds |
| --- | --- |
| [features.md](features.md) | What Tau does for the user and the model. |
| [architecture.md](architecture.md) | How it is built: runtime, layers, data model, build order. |
| [sdk.md](sdk.md) | What extensions, packages and embedding programs can use: the SDK's faces, extension points and types. |
| [tooling.md](tooling.md) | Checks, lint rules, and library choices. |
| [phase-zero.md](phase-zero.md) | Check infrastructure scope, pins, proposed gates, code plan and acceptance cases. |
| [spikes.md](spikes.md) | Questions tested before building, with results. |
| [deferred.md](deferred.md) | Decisions to make later, and what brings each up. |

## Open

Phase zero is complete; its unverified cases are in [deferred.md](deferred.md). Build step 1 (SQLite service, credential store) shipped. Build step 2 (the AI layer) is under way: round 1 is built, and the rest is planned in [work/ai-layer.md](work/ai-layer.md).

SDK, round 1 ([sdk.md](sdk.md)): proposal 1 is open. Should driving Tau from outside (open a session, send a prompt, watch events) be a public part of the SDK, with Tau's own TUI built on it? The answer started with "only concerned with using our TUI"; the rest did not come through.
