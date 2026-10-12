# Architecture

## Runtime and identity

- Bun only. No Node fallback. Distributed as a compiled binary (`bun build --compile`).
- Executable `tau`, global dir `~/.tau`, project dir `.tau/`. Tau never reads Pi's state.
- `@shanepadgett/tau` is the npm package and the extension import name. Inside the binary, a runtime `Bun.plugin` resolves that import to the built-in copy.

## Effect

- Internal layers use Effect 4, pinned to an exact version. Each service is a `Context.Service` with a `Layer`.
- `cli` composes one `ManagedRuntime` and disposes it on every exit path.
- Promises appear only at the edges: the TUI client adapter, the entry point, and the SDK. The SDK documents promises as the default and also offers Effect entry points.
- Unstable modules (`effect/unstable/http`, `encoding`, `effect/FileSystem`, `@effect/platform-bun`) are accepted because the version is pinned, so the compiler's `unstableApiUsage` diagnostic is off.

## AI layer

- Tau's own design. OpenCode's and Pi's `packages/ai` are read-only references for what each protocol needs; no code is copied. The module layout is set in the step's code-level plan.
- All three protocols are built together, with no "first": Anthropic Messages, OpenAI Responses, and Chat Completions with its OpenAI-compatible wrappers. Drop media, Bedrock, and Gemini.
- **Providers are configured routes**: protocol, endpoint, auth, framing, and compatibility settings. An enterprise gateway (Azure OpenAI, LiteLLM, vLLM, an internal proxy) needs only config.
- Each route has typed compatibility settings, such as a message sanitizer and the field that carries the token limit.
- **Provider-native data** (thinking signatures, encrypted reasoning, tool-call IDs) is tagged with its source protocol and model. It is kept on replay to the same model and dropped or converted for a different one.
- Requests are built from the entry log alone; no `previous_response_id`.
- Cross-protocol passes run in fixed order before the body is built: cache breakpoints, tool-history repair, replay rules, Claude Code identity (subscription route), Codex priority tier.
- **Auth is split.** Route auth (credential to headers) and pure OAuth flows live in `ai`. Storage lives in `host`, behind an injected `CredentialStore`. The Claude and ChatGPT subscription login flows ship with the AI layer, not with the TUI.
- **Credential store.** `~/.tau/credentials.db`, a SQLite file readable only by the owner, with one entry per provider: an API key or OAuth tokens. It is separate from settings because settings are hand-edited and shared (dotfiles, project repos) while credentials are secret and rewritten by Tau on every refresh; it is separate from session databases because sessions may be exported. A token refresh runs inside a write transaction, so only one process refreshes at a time (providers replace the refresh token on each use) and the operating system releases the lock if a process dies. When no entry exists, the provider's environment variable, named in the model catalog, is the fallback.
- **Decision APIs ship with the AI layer**: `stream`, `generate`, `generateObject(schema)`, and `classify(enum)`, all on one `LLMRequest` with an optional output schema. Structured output is native per protocol (Anthropic structured outputs, Responses `text.format`, Chat `response_format`), with a forced-tool fallback chosen by compatibility. Invalid output is retried once, then fails with a typed error. An output schema changes the request and compatibility types, so adding it later would be costly.
- Audit and redaction run as middleware around the model call.
- **Model catalog.** A models.dev snapshot is bundled in the binary as the floor. At runtime `ai` fetches the live catalog in the background without blocking startup, and caches it in `~/.tau` through an interface `host` implements, as with credentials. New models appear without a Tau release. A mise task refreshes the bundled snapshot. A model whose entry lacks `structured_output` uses the forced-tool fallback.

## Package layout

One package, `@shanepadgett/tau`, at the repo root. Each layer is a folder under `src/`. Built-ins import the SDK as `@shanepadgett/tau` through package self-reference; inside the binary the runtime plugin resolves it to the same module.

## Layers

Arrows show what a layer may import. Fallow's `boundaries` config enforces them.

```text
cli         entry, print mode; composition root that wires everything
tui         OpenTUI renderer, chat pane, sidebar, slots        ─► core client, sdk
extensions  first-party built-ins                              ─► sdk only
host        settings, credential store, extension/skill/prompt ─► sdk, core, session, database, ai
            loading, AGENTS.md, trust
sdk         deliberate public facade for extensions            ─► core, ai
core        agent loop, services + events, background tasks,   ─► session, sandbox, proc, workspace, ai
            `run` and `checks` tools, compaction scheduling
session     entries, context view, branching,                  ─► database, ai (message types)
            compaction algorithm
database    SQLite service: open, WAL, migrations, transactions,        (leaf)
            decoded rows
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

- Product code is proven by integration tests in `tests/`, one file per flow (such as `tests/compaction.test.ts`), run with `bun test`. Unit tests are allowed only for a pure function with many input cases (wire encoders, stream parsers): a table of inputs and expected outputs, no services or setup, beside the file it tests, with a one-line reason the flow test cannot cover it.
- **Tests run in tiers by speed.**

  | Tier | Contains | Runs |
  | --- | --- | --- |
  | Agent run | Format, lint, types, Fallow, unit tests, in-process integration tests, lint rule tests | `silentCommandRunner.afterRun` in `.pi/tau/settings.json`, when matching files change |
  | Before commit | Compiled-binary tests, the check-infrastructure flow in `tools/checks/` | `silentCommandRunner.beforeCommit`, once per `/commit`; no Git hook |
  | Live | Real provider calls | By hand |

  In-process tests drive the core client interface in one process, so each takes milliseconds. The agent-run `test` task runs files with `bun test --parallel` and fails any test over 1 second (`--timeout 1000`); a slower test moves to the before-commit tier. The 1-second limit applies to the agent-run tier only: before-commit tests run from their own tasks without it, bounded only by each `beforeCommit` command's `timeoutMs`. Tests within a file run in order. Each test uses its own temporary directory, and the fake provider listens on port 0, so parallel files never share paths or ports. Before-commit commands must not change the working tree, so compiled binaries are built in a temporary directory.
- Check tooling in `tools/` may have unit tests, colocated beside the file they test (`tools/lint/no-module-let.test.ts`). Check-infrastructure integration tests live in `tools/checks/`. `tests/` holds only the application's tests, so `mise run test` runs for `src/` and `tests/` changes, `mise run test:rules` runs for `tools/lint/` changes, and the slower check-infrastructure flow (`mise run test:checks`) runs before commit. Lint rules use oxlint's `RuleTester`, which does not run under Bun, so they run under Node 24 (`node --test`) as a temporary arrangement; `AGENTS.md` says when to check whether Bun now works. Integration tests keep covering what the real tools do with our configuration: scoping, fixes, formatter, fallow and hooks.
- Most drive the core client interface with a real session database in a temp directory and a real sandbox. A few drive the compiled binary: print mode directly, the TUI inside a PTY.
- Models come from a fake provider: a local HTTP server in `tests/support/fake-provider/`, shared by all flow tests, that encodes neutral scripted events into each wire protocol, reached through the provider's base URL. Every flow runs on all three protocols.
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
- **SQLite.** `bun:sqlite` directly, behind our own Effect service in the `database` layer, used by `session` and `host`: `acquireRelease`, WAL, `PRAGMA user_version` migrations, Schema-decoded rows, tagged errors. Not `effect/sql`: it is unstable, issue #8920 reports lost writes on Effect 4.0.2 with Bun 1.4.0, and OpenCode wrote its own `bun:sqlite` driver.
- **Sandbox.** QuickJS (`quickjs-wasi`) runs in a `Worker`, with its WASM embedded in the binary. Host functions are async and cancellable; a shared flag interrupts CPU-bound scripts.
- **Change detection.** Files change through scripts, `sh`, and background processes, so tool arguments cannot say what changed. Core uses the `workspace` layer to compare the working tree before and after each `run` call (`git status` plus hashes of changed and untracked files). The result feeds `fix` checks (`{files}`) and marks `checks` results stale.
- **Background task recovery.** None for now. Work interrupted by a crash starts over on the next turn.
- **PTYs.** Bun's built-in `Bun.Terminal`, not `node-pty`; verified in compiled binaries on macOS and Linux arm64. Spawn with `detached: true`. Cancellation must cover owned descendants across shell job-control groups, then close the terminal; the spike's snapshot cleanup is not a production supervisor. Lives in `proc`.

## Build order

Each step builds only on earlier steps.

| Step | Builds | Needs |
| --- | --- | --- |
| 1 | `database` SQLite service; `host` credential store | nothing |
| 2 | `ai`: routes, three protocols, structured output, OAuth flows, model catalog; `host` settings file and environment-variable credential fallback | 1: OAuth refresh tokens must be saved; routes are the first setting and the catalog names the variables |
| 3 | `session`: entries, context view | 1: the SQLite service |
| 4 | `core` turn loop and `run` tool, driven by print mode | 2, 3: the loop reads and writes entries |
| 5 | Background tasks, compaction | 4 |
| 6 | TUI and interactive shell | 4, 5 |
| 7 | Extension host and SDK; redesign Tau's built-ins from `main` | 4, 6 |
| 8 | Packages, install, updates | 7 |
