# Tau Standalone

Status: nine spikes complete on macOS; OpenTUI, PTYs and file finding also verified on Linux arm64. Layers, package layout, Effect, the AI layer, the turn loop, SQLite access, tooling, FFF and helper reuse are settled. Use unpatched FFF first; reconsider the tested native workaround if a ranking bug is opened.

Tau becomes its own coding agent, built from the ground up on this branch. It does not embed or depend on Pi. OpenCode and Pi are read-only references for learning which problems they solved and how; Tau writes its own code on its own architecture and copies none of theirs. Their published packages may be dependencies like any other, such as `@opencode/codemode` behind `run`. The `main` branch stays a Pi package and keeps shipping until this branch replaces it.

| File | Holds |
| --- | --- |
| [features.md](features.md) | What Tau does for the user and the model. |
| [architecture.md](architecture.md) | How it is built: runtime, layers, data model, build order. |
| [sdk.md](sdk.md) | The SDK's shape: one public face for extensions, four kinds of extension point, the scoped context, public types. |
| [sdk-packages.md](sdk-packages.md) | How extensions are packaged, installed, started and versioned. |
| [sdk-catalog.md](sdk-catalog.md) | What each SDK area offers, the replaceable runtime parts, the stable-prefix rules and the named UI places. |
| [tooling.md](tooling.md) | Checks, lint rules, and library choices. |
| [phase-zero.md](phase-zero.md) | Check infrastructure scope, pins, proposed gates, code plan and acceptance cases. |
| [spikes.md](spikes.md) | Questions tested before building, with results. |
| [deferred.md](deferred.md) | Decisions to make later, and what brings each up. |

## Open

Phase zero is complete; its unverified cases are in [deferred.md](deferred.md). Build step 1 (SQLite service, credential store) shipped. Build step 2 (the AI layer) is under way: round 1 is built, and the rest is planned in [work/ai-layer.md](work/ai-layer.md).

SDK rounds 1–3 are agreed. Round 4 (isolation and trust) is planned before build step 7.

Under consideration: OpenAI's Sign in with ChatGPT as a subscription login for the public Responses API, alongside or instead of the Codex login. Findings are in [work/ai-layer.md](work/ai-layer.md#under-consideration-sign-in-with-chatgpt).

Next: the compiled-binary `tau login` test, then round 3: the model catalog, the settings file, and the OpenCode Go route ([work/ai-layer.md](work/ai-layer.md#later-rounds)).
