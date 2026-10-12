# Architecture

## Runtime and identity

- Bun only. No Node fallback. Distributed as a compiled binary (`bun build --compile`).
- Executable `tau`, global dir `~/.tau`, project dir `.tau/`. Tau never reads Pi's state.
- `@shanepadgett/tau` is the npm package and the extension import name. Inside the binary, a runtime `Bun.plugin` resolves that import to the built-in copy.

## Effect

- Internal layers use Effect 4, pinned to an exact version. Each service is a `Context.Service` with a `Layer`.
- `cli` composes one `ManagedRuntime` and disposes it on every exit path.
- Promises appear only at the edges: the TUI client adapter, the entry point, and the SDK. The SDK documents promises as the default and also offers Effect entry points.
- Unstable modules (`effect/unstable/http`, `encoding`) are accepted because the version is pinned.

## AI layer

- Port OpenCode's `packages/ai` (MIT, Effect 4), trimmed. Keep `route/` (protocol, framing, endpoint, auth, executor, client) and `schema/` (messages, events, errors, options).
- All three protocols are built together, with no "first": Anthropic Messages, OpenAI Responses, and Chat Completions with its OpenAI-compatible wrappers. Drop media, Bedrock, and Gemini.
- **Providers are configured routes**: protocol, endpoint, auth, framing, and compatibility settings. An enterprise gateway (Azure OpenAI, LiteLLM, vLLM, an internal proxy) needs only config.
- Keep OpenCode's typed compatibility settings (message sanitizer, `maxTokensField`). Add Pi's replay rule if the port lacks it.
- **Provider-native data** (thinking signatures, encrypted reasoning, tool-call IDs) is tagged with its source protocol and model. It is kept on replay to the same model and dropped or converted for a different one.
- Requests are built from the entry log alone; no `previous_response_id`.
- Cross-protocol passes run in fixed order before the body is built: cache breakpoints, tool-history repair, replay rules, Claude Code identity (subscription route), Codex priority tier.
- **Auth is split.** Route auth (credential to headers) and pure OAuth flows live in `ai`. Storage lives in `host`, behind an injected `CredentialStore`.
- **Decision APIs ship in step 1**: `stream`, `generate`, `generateObject(schema)`, and `classify(enum)`, all on one `LLMRequest` with an optional output schema. Structured output is native per protocol (Anthropic structured outputs, Responses `text.format`, Chat `response_format`), with a forced-tool fallback chosen by compatibility. Invalid output is retried once, then fails with a typed error. An output schema changes the request and compatibility types, so adding it later would be costly.
- Audit and redaction run as middleware around the model call.
- The model list is generated from models.dev by a mise task into `src/ai/models.generated.ts`, which is committed.

## Package layout

One package, `@shanepadgett/tau`, at the repo root. Each layer is a folder under `src/`. Built-ins import the SDK as `@shanepadgett/tau` through package self-reference; inside the binary the runtime plugin resolves it to the same module.

## Layers

Arrows show what a layer may import. Fallow's `boundaries` config enforces them.

```text
cli         entry, print mode; composition root that wires everything
tui         OpenTUI renderer, chat pane, sidebar, slots        ─► core client, sdk
extensions  first-party built-ins                              ─► sdk only
host        settings, auth store, extension/skill/prompt       ─► sdk, core, session, ai
            loading, AGENTS.md, trust
sdk         deliberate public facade for extensions            ─► core, ai
core        agent loop, services + events, background tasks,   ─► session, sandbox, proc, workspace, ai
            `run` and `checks` tools, compaction scheduling
session     SQLite storage, entries, context view, branching,  ─► ai (message types)
            compaction algorithm
sandbox     QuickJS in a Worker, host-function bridge, interrupt flag   (leaf)
proc        process sessions, PTYs, tree kill                           (leaf)
workspace   snapshot and diff of the working tree                       (leaf)
ai          providers, streaming, message format, OAuth flows,          (leaf)
            structured output, classify
```

- **Leaves know nothing of the agent.** `core` holds the policy: what `run` exposes, when checks run, when change detection runs.
- **Compaction is split.** `session` owns the pure parts (cut point, compaction entry, context view) and takes a `summarize` function. `core` owns thresholds and scheduling. This removes a `session`/`core` import cycle.
- **Credentials are injected.** `ai` takes credentials through an interface; `host` implements it on `~/.tau`.
- **Built-ins use only the SDK**, which proves it is enough for third parties. Extensions get a context object on activation, not module-level globals, so `/reload` leaves nothing stale.
- **One client interface.** `tui` and print mode talk to `core` through one type, roughly `{ send(command), subscribe(listener) }`.

## Tooling and libraries

Checks, lint rules, and library choices are in [tooling.md](tooling.md).

## Testing

- Product code has integration tests only; no unit tests. They live in `tests/`, one file per flow (such as `tests/compaction.test.ts`), and run with `bun test`.
- Check tooling in `tools/` may have unit tests, colocated beside the file they test (`tools/lint/no-module-let.test.ts`). Check-infrastructure integration tests live in `tools/checks/`. `tests/` holds only the application's tests, so `mise run test` runs for `src/` and `tests/` changes and `mise run test:checks` runs for `tools/` and check configuration changes. Lint rules use oxlint's `RuleTester`, which does not run under Bun, so they run under Node 24 (`node --test`) as a temporary arrangement; `AGENTS.md` says when to check whether Bun now works. Integration tests keep covering what the real tools do with our configuration: scoping, fixes, formatter, fallow and hooks.
- Most drive the core client interface with a real session database in a temp directory and a real sandbox. A few drive the compiled binary: print mode directly, the TUI inside a PTY.
- Models come from a fake provider: a local HTTP server in the test suite that encodes neutral scripted events into each wire protocol, reached through the provider's base URL. Every flow runs on all three protocols.
- A separate live suite calls real providers. It needs keys and costs money, so it runs by hand.

## Core ideas

- **One command and event interface.** The TUI and print mode are both clients of it, so RPC can be added later as a thin layer.
- **Turn loop.** A re-entrant step function, after Goose's design. Each step reads the session's entries, runs an ordered list of operations, and persists the effects of the first operation that applies. Status is `continuing`, `yielded`, or `cancelled`. Nothing lives between steps except entries, so a session can be rebuilt after any step; a test rebuilds it after every step to prove this.
- **Operations are the extension point for turn behavior.** Extensions add them through the SDK in named phases (`input`, `tools`, `recovery`); inference is always last and collects tools and prompt parts from every operation. Built-ins use the same API. An operation records what it did in entry metadata, never in memory. Each step records which operation applied, for inspection.
- **Effects and events are separate.** Effects only append entries. Events are the live stream (text deltas, tool progress, usage) and are not stored.
- **One writer per session.** A runner fiber takes commands from a bounded queue and runs steps one at a time. Steering is queued and injected at the next step boundary.
- **Cancellation.** Interrupting the step finalizes the interrupted operation, answers every open tool call with an "interrupted" result, then finalizes the other operations.
- **Middleware only around I/O.** The model call and tool execution can be wrapped (audit, redaction), with declared order.
- **Background tasks.** Core runs work beside the chat: compaction, classifier and routing calls, process sessions. Each task reports status events, which feed the sidebar. Work that changes the conversation while it is busy is applied at the next turn boundary.
- **Session data model.** Entries are never deleted. A compaction entry holds a summary and points to the first kept entry. The context the model sees is computed from entries: the latest summary, then everything from its kept entry on. No Pi session import.
- **SQLite.** `bun:sqlite` directly, behind our own Effect service: `acquireRelease`, WAL, `PRAGMA user_version` migrations, Schema-decoded rows, tagged errors. Not `effect/sql`: it is unstable, issue #8920 reports lost writes on Effect 4.0.2 with Bun 1.4.0, and OpenCode wrote its own `bun:sqlite` driver.
- **Sandbox.** QuickJS (`quickjs-wasi`) runs in a `Worker`, with its WASM embedded in the binary. Host functions are async and cancellable; a shared flag interrupts CPU-bound scripts.
- **Change detection.** Files change through scripts, `sh`, and background processes, so tool arguments cannot say what changed. Core uses the `workspace` layer to compare the working tree before and after each `run` call (`git status` plus hashes of changed and untracked files). The result feeds `fix` checks (`{files}`) and marks `checks` results stale.
- **Background task recovery.** None for now. Work interrupted by a crash starts over on the next turn.
- **PTYs.** Bun's built-in `Bun.Terminal`, not `node-pty`; verified in compiled binaries on macOS and Linux arm64. Spawn with `detached: true`. Cancellation must cover owned descendants across shell job-control groups, then close the terminal; the spike's snapshot cleanup is not a production supervisor. Lives in `proc`.

## Build order (draft)

1. AI layer, including structured output, tested against the fake provider and the live suite.
2. Agent loop and `run` tool, driven by print mode.
3. Sessions, background tasks, and compaction.
4. TUI and interactive shell.
5. Extension host and SDK; port Tau's built-ins from `main`.
6. Settings, packages, install, and updates.
