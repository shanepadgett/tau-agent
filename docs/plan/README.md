# Tau Standalone

Status: four spikes complete on macOS; OpenTUI and PTYs also verified on Linux arm64. Architecture not settled.

Tau becomes its own coding agent, built from the ground up on this branch. It does not embed or depend on Pi. Pi's code (MIT) may be read and ported where that is faster, keeping its license notice. The `main` branch stays a Pi package and keeps shipping until this branch replaces it.

| File | Holds |
| --- | --- |
| [features.md](features.md) | What Tau does for the user and the model. |
| [architecture.md](architecture.md) | How it is built: runtime, layers, data model, build order. |
| [spikes.md](spikes.md) | Questions tested before building, with results. |

## Open

- One package with `src/` folders or workspaces.
- Whether to start the AI layer with Chat Completions.
- Whether a separate raw shell tool beats a shell function inside the sandbox. Test once the agent loop runs.
