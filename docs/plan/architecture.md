# Architecture

## Runtime and identity

- Bun only. No Node fallback. Distributed as a compiled binary (`bun build --compile`).
- Executable `tau`, global dir `~/.tau`, project dir `.tau/`. Tau never reads Pi's state.
- `@shanepadgett/tau` is the npm package and the extension import name. Inside the binary, a runtime `Bun.plugin` resolves that import to the built-in copy.

## Effect

- Internal layers use Effect 4, pinned to an exact version. Each service is a `Context.Service` with a `Layer`.
- `cli` composes one `ManagedRuntime` and disposes it on every exit path.
- Promises appear only at the edges: the TUI client adapter, the entry point, and the SDK. The SDK documents promises as the default and also offers Effect entry points.
- Unstable modules (`effect/http`, `effect/ai`, `encoding`, `effect/FileSystem`, `@effect/platform-bun`) are accepted because the version is pinned, so the compiler's `unstableApiUsage` diagnostic is off.

## AI layer

- **Built on Effect's AI modules.** `effect/ai` supplies the model interface (`LanguageModel` with `generateText`, `generateObject`, `streamText`), the `Prompt` and `Response` part types, `AiError`, and `Tool`. Four first-party packages at Effect's pinned version speak the protocols: `@effect/ai-anthropic` (Messages), `@effect/ai-openai` (Responses, for the OpenAI API key and the Codex subscription), `@effect/ai-openrouter` (OpenRouter, which keeps Claude's reasoning details on replay) and `@effect/ai-openai-compat` (other Chat Completions services, such as OpenCode Go and gateways). Tau writes routes, auth, subscriptions, the cross-protocol passes and the model catalog. This beat writing all three protocols because the packages already handle thinking signatures, encrypted reasoning, caching and typed errors; the cost is following Effect's unstable AI API across upgrades. OpenCode's and Pi's `packages/ai` remain read-only references for what each subscription needs; no code is copied. The module layout is set in the step's code-level plan. Spike 8 in [spikes.md](spikes.md) confirmed every route, structured output, decisions, replay and recorded traffic on these packages.
- **ChatGPT plan routes only stream.** On both plan routes, `src/ai/internal/protocols/responses-stream.ts` sends non-streaming requests (such as `generateObject`) as streams. It builds the reply from the `response.output_item.done` events, because the completed event's `output` can be empty, and drops `phase: "commentary"` messages. OpenRouter routes set `strictJsonSchema: true`, or some upstream providers ignore the schema.
- **Escape hatch per protocol.** If a package cannot do what a route needs, `transformClient` or the request config covers it first; failing that, Tau implements that one protocol behind `LanguageModel.make`, and no caller changes.
- **Sessions store Tau's own entry schema, never Effect's part types.** Entries are converted to `Prompt` parts when a request is built, so an Effect upgrade cannot break saved sessions.
- The agent loop runs tools itself: requests set `disableToolCallResolution`.
- All three protocols ship together, with no "first": Anthropic Messages, OpenAI Responses, and Chat Completions with its OpenAI-compatible wrappers. Drop media, Bedrock, and Gemini.
- **Providers are configured routes**: protocol, endpoint, auth, and request config, each mapped onto one of the four Effect packages. An enterprise gateway (Azure OpenAI, LiteLLM, vLLM, an internal proxy) needs only config.
- Each route has typed compatibility settings, such as a message sanitizer and the field that carries the token limit.
- **Provider-native data** (thinking signatures, encrypted reasoning, tool-call IDs) rides in Effect's per-provider part options. Each package ignores other providers' options, so a cross-provider replay drops it with no Tau code, and Claude accepts a signature from another Claude model (spike 8 in [spikes.md](spikes.md)).
- Requests are built from the entry log alone; no `previous_response_id`.
- Cross-protocol passes run in fixed order on the `Prompt` before the request: cache breakpoints (system, user and tool-result parts; Effect ignores them on assistant parts), tool-history repair. Route config adds the Codex priority tier and `session-id` cache header. The Claude subscription route makes every request look like Claude Code's (`src/ai/internal/signing/claude-code.ts`): Claude Code's betas, `user-agent: claude-cli/<version>` and `x-app: cli`, and the Claude Code identity as the first system block. Anthropic refuses subscription requests without them (spike 10).
- **Auth is split.** Route auth (credential to headers) and pure OAuth flows live in `ai`. Storage lives in `host`, behind an injected `CredentialStore`. The Claude and ChatGPT subscription login flows ship with the AI layer, not with the TUI.
- **Credential store.** `~/.tau/credentials.db`, a SQLite file readable only by the owner, with one entry per provider: an API key or OAuth tokens. It is separate from settings because settings are hand-edited and shared (dotfiles, project repos) while credentials are secret and rewritten by Tau on every refresh; it is separate from `sessions.db` because sessions may be exported. A token refresh runs inside a write transaction, so only one process refreshes at a time (providers replace the refresh token on each use) and the operating system releases the lock if a process dies. When no entry exists, `ai` falls back to the route's environment variable through Effect's `Config`, so tests set it with a `ConfigProvider` and no Tau code reads `process.env`. The ChatGPT account ID is read from the access token, not stored.
- **Logins.** `tau login` and `tau logout` take no arguments and are the only way to add or remove a credential. They list the built-in and settings routes that take a key or a login. Claude logs in through the browser or a copy-code page; the Codex login through the browser or a device code; Sign in with ChatGPT through the browser or a pasted address. Callback servers use fixed ports (Claude 53692, ChatGPT 1455). When a port is taken, Tau asks for the pasted address. OAuth tokens refresh within a minute of expiry, inside `CredentialStore.update`. A refused refresh (400 or 401) asks the user to log in again.
- **Two ChatGPT plan logins, as equal choices.** Both spend the same plan allowance.
  - `chatgpt` (Sign in with ChatGPT) registers Tau as its own app and sends requests to the public Responses API. It checks the ID token against OpenAI's keys at login, and logout revokes the refresh token. It sends a host ID from `~/.tau/host-id`, which is kept apart from credentials, so copied credentials do not copy the machine's identity.
  - `codex` (Codex login) uses the Codex backend and works without a browser.
  - Neither token works for OpenAI Decisions.
- **Request identity.** `Models.languageModel(ref, conversationId)` takes the ID of the conversation; a call outside a session makes a new one. OpenCode Go requires `x-opencode-session` and `x-opencode-client: tau` on its requests. Every request except a Claude subscription request carries `user-agent: tau/<version>`.
- **Messages replies from other servers.** Servers that speak Messages, such as OpenCode Go, can leave out fields that Anthropic always sends. `src/ai/internal/protocols/messages-defaults.ts` adds Anthropic's defaults so Effect's client can decode the reply.
- **Model calls ship with the AI layer**: `streamText`, `generateText` and `generateObject(schema)` come from `LanguageModel`. `Models.languageModel` wraps each model's `generateObject` (`src/ai/internal/protocols/structured-output.ts`), so every caller keeps Effect's API:
  - A model with native structured output uses it (Anthropic structured outputs, Responses `text.format`, Chat `response_format`). The catalog decides, not Effect's guess from Claude model names.
  - Other models return the object as the parameters of one forced tool call. Confirmed live on OpenCode Go for Chat Completions and Messages.
  - An invalid object gets one retry that sends the invalid answer and the reason, then fails with `StructuredOutputError`. When Effect refuses the tool parameters while reading the reply, the retry sends only the reason.
  - Models that cannot call tools are hidden, because Tau works only through tools. A settings entry with `supports.tools: true` brings one back. The schema must be an object.
- **Decision models are a separate API, not chat.** They answer classify, rate and probability questions over a JSON state through Effect's `DecisionModel` service, which validates the answers. Tau writes one small adapter per wire API behind `DecisionModel.make`: TypeSafe's System One (`POST /api/v1/systemone` on OpenRouter, serving Jev and Luna), and OpenAI's Decisions API (Luna, `POST /v1/decisions`). `@effect/ai-openrouter`'s own decision model posts to an endpoint that returns 404. OpenAI Decisions accepts only API keys, not ChatGPT subscription tokens, so the OpenAI API-key route is required.
- Audit and redaction run as middleware around the model call.
- **Model catalog.** Effect's packages know only model IDs, so Tau keeps its own catalog (`src/ai/Catalog.ts`) of context windows, prices, abilities and protocols. Four sources merge in order, and later sources win:
  1. a trimmed models.dev snapshot bundled in the binary (`mise run catalog` refreshes it);
  2. a cached refresh, at most once a day (`~/.tau/catalog.json`);
  3. the plan routes' live model lists, which hide models the plan does not offer and set the plan's context window;
  4. `~/.tau/settings.json`.

  Plan routes show API prices, labelled as plan usage. The protocol is chosen per model, so OpenCode Go is one route with three protocols. Decision models come from a built-in list per route, because models.dev's list uses other IDs and omits Luna. An unknown model fails with a hint to add it in the settings file. The daily refresh also reads the Claude Code version from npm, never below the bundled floor. Building the catalog starts no request: session start (build step 4) runs `refreshIfStale` in the background.
- **Settings file.** `~/.tau/settings.json` (JSONC, checked with Effect Schema) adds routes, such as a local Ollama server, and corrects models. Built-in routes may change only `models` and `decisionModels`. A route without `apiKeyEnv` sends no key. Routes are user-level only, until SDK round 4 decides how far to trust a project. Tau reads the file on start.

## Package layout

One package, `@shanepadgett/tau`, at the repo root. Each layer is a folder under `src/`. Built-ins import the SDK as `@shanepadgett/tau` through package self-reference; inside the binary the runtime plugin resolves it to the same module.

Every layer has the same shape, after Effect's own layout and its service docs (`docs/reference/copies/effect/4.0.3/ai-docs/src/01_effect/03_services/`):

```text
src/<layer>/
  Sessions.ts      public module: PascalCase, named after what it exports
  internal/        private to the layer, grouped by topic once a topic has two files
tests/<layer>/<flow>.test.ts
```

- **Fallow enforces it:** each layer has a zone for its root files and one for `internal/`, and only the layer itself may import its `internal/`. Tests may import `ai-internal` until the HTTP fake provider exists ([deferred.md](deferred.md)).
- **No re-export files.** A public module defines what it exports; it may re-export a name defined in its own `internal/`.
- **A service carries its layer:** `static readonly layer` on the `Context.Service` class. Paths and settings come from services, never arguments: `TauHome` (`src/database/TauHome.ts`) is Tau's home folder, which `cli` provides and tests point at a temporary folder.
- **A layer declares what it needs; another implements it.** `ai` declares `CredentialStore`, `CatalogCache`, `RouteTable` and `HostId`; `host` implements them on `~/.tau` and exports one `<service>Layer` each (Fallow rejects the same export name in several modules). `Settings.layer` reads `settings.json` once and provides both the run settings and the route table.
- **Values with a default** that tests replace are `Context.Reference`s, such as `CatalogSources`.
- **Effect modules before hand-built ones:** processes through `ChildProcessSpawner`, per-key resources through `RcMap`, the running fiber through `FiberHandle`, console I/O through `Stdio`.

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
sandbox     `@opencode/codemode` runtime, Tau's functions as its tools  (leaf)
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
  | Before commit | Compiled-binary tests in `tests/binary/` (`mise run test:binary`); the agent-run `test` task skips that folder | `silentCommandRunner.beforeCommit`, once per `/commit`; no Git hook |
  | Live | Real provider calls | By hand |

  In-process tests drive the core client interface in one process, so each takes milliseconds. The agent-run `test` task runs files with `bun test --parallel` and fails any test over 1 second (`--timeout 1000`); a slower test moves to the before-commit tier. The 1-second limit applies to the agent-run tier only: before-commit tests run from their own tasks without it, bounded only by each `beforeCommit` command's `timeoutMs`. Tests within a file run in order. Each test uses its own temporary directory, and the fake provider listens on port 0, so parallel files never share paths or ports. Before-commit commands must not change the working tree, so compiled binaries are built in a temporary directory.
- Check tooling in `tools/` may have unit tests beside the file they test (`tools/lint/no-module-let.test.ts`). The checks themselves are proven by running on the real repository; nothing builds sample projects to test them, as in Pi and OpenCode. `mise run test` runs for `src/` and `tests/` changes, and `mise run test:rules` for `tools/lint/` changes. Lint rules use oxlint's `RuleTester`, which does not run under Bun, so they run under Node 24 (`node --test`) as a temporary arrangement; `AGENTS.md` says when to check whether Bun now works.
- Most drive the core client interface with a real session database in a temp directory and a real sandbox. A few drive the compiled binary: print mode directly, the TUI inside a PTY.
- Models come from a fake provider: a local HTTP server in `tests/support/fake-provider/`, shared by all flow tests, that encodes neutral scripted events into each wire protocol, reached through the provider's base URL. Every flow runs on all three protocols.
- **Provider streams are recorded, not hand-written.** Raw streams from each real provider and subscription are recorded once, with secrets removed, and checked in. Protocol tests replay them from a local `Bun.serve` through the real Effect clients; the fake provider's encoders are checked against them so scripted streams match what providers send.
- A separate live suite calls real providers. It needs keys and costs money, so it runs by hand.

## Core ideas

- **One command and event interface.** The TUI and print mode are both clients of it, so RPC can be added later as a thin layer.
- **Agent loop.** A re-entrant step function, after Goose's design. Each step reads the session's entries, runs an ordered list of operations, and persists the effects of the first operation that applies. Status is `continuing`, `yielded`, or `cancelled`. Nothing lives between steps except entries, so a session can be rebuilt after any step; a test rebuilds it after every step to prove this.
- **Operations are the extension point for turn behavior.** Extensions add them through the SDK in named phases (`input`, `tools`, `recovery`); inference is always last and collects tools and prompt parts from every operation. Built-ins use the same API. An operation records what it did in entry metadata, never in memory. Each step records which operation applied, for inspection.
- **Effects and events are separate.** Effects only append entries. Events are the live stream (text deltas, tool progress, usage) and are not stored.
- **One writer per session.** A runner fiber takes commands from a bounded queue and runs steps one at a time. Steering is queued and joins the run after the current turn. Follow-up messages wait until the run ends, then start the next run.
- **Cancellation.** Interrupting the step finalizes the interrupted operation, answers every open tool call with an "interrupted" result, then finalizes the other operations.
- **Middleware only around I/O.** The model call and tool execution can be wrapped (audit, redaction), with declared order.
- **Background tasks.** Core runs work beside the chat: compaction, classifier and routing calls, process sessions. Each task reports status events, which feed the sidebar. Work that changes the conversation while it is busy is applied at the next turn boundary.
- **Stable prefix between compactions.** Providers cache a request by its prefix, so changing anything early (system prompt, function list, old entries) re-bills the whole session. Between compactions, what the model sees only grows at the end: a new date, a changed instruction file or a newly found function arrives as a new entry. Compaction already discards the cache, so it is the one point where late additions fold back into the system prompt and the function list.
- **Instructions are value deltas,** after OpenCode's session design. Guidance other than the base prompt comes from keyed instruction sources. Before each model call, `core` reads them and appends one entry recording which values changed. The system prompt renders the values from the last compaction; each later change is rendered once into that entry and shown to the model as a note at that point in the chat. Details in [sdk-catalog.md](sdk-catalog.md#stable-prefix).
- **Session data model.** Entries are never deleted. A compaction entry holds a summary and points to the first kept entry. The context the model sees is computed from entries: the latest summary, then everything from its kept entry on. No Pi session import.
- **Sessions** (`src/session/`, build step 3). All sessions live in one shared SQLite file, `~/.tau/sessions.db`, as in Goose and OpenCode, so listing, search and branches are queries; export writes one session to its own file. Several Tau processes share the file; entry numbers are given inside a write transaction.
- **Agent loop as built** (slice 4a, `src/core/`). `Agent.open` gives an open session, held for the caller's scope, with `subscribe` and `send`. Clients of one session share its runner (an `RcMap` entry): prompts wait in a `Queue` and run one at a time, so the session has one writer. Each prompt carries its run options, so the model can change between prompts. A cancel takes the waiting prompts off the queue and sends them back in a `prompts-returned` event (the TUI puts them back in the editor), then interrupts the running prompt through a `FiberHandle`. The handle gets the fiber before it starts, so a cancel sent in answer to the run's first event still finds it. Events (`text`, `tool-started`, `tool-ended`, `run-ended`) go to subscribers and are not saved. A step tries, in order: interrupt calls that started and have no result, run open tool calls, stop at the turn limit, call the model.
  - **Safety rules** (from [loop-research.md](loop-research.md)): a `tool-started` entry is saved before a call runs, and after a crash such a call gets an "interrupted" result instead of running again. The context view puts each result right after its call, gives a call without a result an error result, and drops a result without a call. A cancelled reply's text is saved as interrupted and left out of later model calls.
  - **No turn limit by default.** Long runs are normal; `maxTurns` in settings sets one.
  - **Timeouts:** a whole `run` call defaults to 10 minutes (codemode's per-run `timeoutMs`), one `sh` call to 2 minutes; the model can set either per call, `timeouts.run` and `timeouts.shell` in settings change the defaults, and the `run` timeout always wins. `proc` starts commands in their own process group and kills the group on timeout, cancel or exit.
  - **Print mode:** `tau -p "prompt"` or a prompt on stdin; `--session <id>`, `--model route/model` (the route ends at the first slash), else `model` in settings, else Tau stops and says how to set one. The answer streams to stdout; tool lines and the session ID go to stderr. No approval prompts: `run` acts with the user's permissions.
  - **Tests** use a scripted in-process model through the `Models` service; everything else is real. They move to the HTTP fake provider when it is built ([deferred.md](deferred.md)).
  - A session is one ordered list of entries, numbered from 1. The number is the cursor an SDK subscriber resumes from (`Sessions.entries(session, after)`).
  - **A branch is a new session**, as in OpenCode and Codex: `fork` copies the parent's entries up to the chosen one, and the new session records where it came from. The branch tree is a tree of sessions. Pi's tree inside one file was rejected: every reader walks parent links, and Pi still needed `/fork` and `/clone` beside `/tree`.
  - Entries hold Tau's own types as JSON: user text, assistant parts (text, reasoning, tool calls) and tool results. Provider data, such as a Claude thinking signature, is kept per part without being read.
  - `contextView` turns entries into an Effect `Prompt`; it is the only code that knows Effect's prompt types. Consecutive tool results become one tool message. The system prompt and the compaction rule are added by `core` (step 4) and compaction (step 5).
  - Each session records its working directory; `list` shows that directory's sessions, most recently changed first. The session ID is the conversation ID passed to `Models.languageModel`.
- **SQLite.** `bun:sqlite` directly, behind our own Effect service in the `database` layer, used by `session` and `host`: `acquireRelease`, WAL, `PRAGMA user_version` migrations, Schema-decoded rows, tagged errors. Not `effect/sql`: it is unstable, issue #8920 reports lost writes on Effect 4.0.2 with Bun 1.4.0, and OpenCode wrote its own `bun:sqlite` driver.
- **Sandbox.** `@opencode/codemode`, an interpreter for a JavaScript subset written on Effect ([spike 9](spikes.md)). Scripts reach only the functions Tau gives them, defined with `Tool.make` and Effect Schemas. It runs on the main thread: interruption and timeouts stop busy loops while the event loop keeps ticking. Pinned, with an `effect` override so one Effect copy is installed. Replaces QuickJS in a worker.
- **Change detection.** Files change through scripts, `sh`, and background processes, so tool arguments cannot say what changed. Core uses the `workspace` layer to compare the working tree before and after each `run` call (`git status` plus hashes of changed and untracked files). The result feeds `fix` checks (`{files}`) and marks `checks` results stale.
- **Background task recovery.** None for now. Work interrupted by a crash starts over on the next run.
- **PTYs.** Bun's built-in `Bun.Terminal`, not `node-pty`; verified in compiled binaries on macOS and Linux arm64. Spawn with `detached: true`. Cancellation must cover owned descendants across shell job-control groups, then close the terminal; the spike's snapshot cleanup is not a production supervisor. Lives in `proc`.

## Build order

Each step builds only on earlier steps.

| Step | Builds | Needs |
| --- | --- | --- |
| 1 | `database` SQLite service; `host` credential store | nothing |
| 2 | `ai`: routes, three protocols, structured output, OAuth flows, model catalog; `host` settings file and environment-variable credential fallback | 1: OAuth refresh tokens must be saved; routes are the first setting and the catalog names the variables |
| 3 | `session`: entries, context view | 1: the SQLite service |
| 4 | `core` agent loop and `run` tool, driven by print mode | 2, 3: the loop reads and writes entries |
| 5 | Background tasks, compaction | 4 |
| 6 | TUI and interactive shell | 4, 5 |
| 7 | Extension host and SDK; redesign Tau's built-ins from `main` | 4, 6 |
| 8 | Packages, install, updates | 7 |
