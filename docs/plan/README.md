# Tau Standalone

Status: seven spikes complete on macOS; OpenTUI, PTYs and file finding also verified on Linux arm64. Layers, package layout, Effect, the AI layer, the turn loop, SQLite access, tooling, FFF and helper reuse are settled. Use unpatched FFF first; reconsider the tested native workaround if a ranking bug is opened.

Tau becomes its own coding agent, built from the ground up on this branch. It does not embed or depend on Pi. Pi's code (MIT) may be read and ported where that is faster, keeping its license notice. The `main` branch stays a Pi package and keeps shipping until this branch replaces it.

| File | Holds |
| --- | --- |
| [features.md](features.md) | What Tau does for the user and the model. |
| [architecture.md](architecture.md) | How it is built: runtime, layers, data model, build order. |
| [tooling.md](tooling.md) | Checks, lint rules, and library choices. |
| [spikes.md](spikes.md) | Questions tested before building, with results. |
| [deferred.md](deferred.md) | Decisions to make later, and what brings each up. |

## Open

None.
