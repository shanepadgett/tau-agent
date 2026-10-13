# Code health: one shape for every module

Status: archived. Built 2026-10-13; checks pass. Its lasting decisions are in [architecture.md](../architecture.md#package-layout) and [deferred.md](../deferred.md).

The goal: every part of `src/` has the same shape, taken from Effect's documentation (`docs/reference/copies/effect/4.0.3/ai-docs/src/`: `01_effect/03_services`, `05_resources`, `60_child-process`, `09_testing`), so an agent or a generator can add a part without inventing one.

## Round 1 (agreed)

1. **Effect's own layout.** Public modules are PascalCase files at a layer's root, named after what they export. Everything else is under `internal/`, grouped by topic once a topic has two files. Fallow zones keep `internal/` private to its layer. No re-export files. Feature folders were weighed and rejected: they need a custom lint rule, and they spread a layer's public modules across folders.
2. **One service template.** The layer sits on the service class (`static readonly layer`). Paths and settings come from services, not arguments. Tests swap services by layer.
3. **Effect modules instead of hand-built code:** `ChildProcessSpawner`, `RcMap`, `Queue`, `FiberHandle`, `Ref`, `Stdio`, tagged errors, logged `Effect.ignore`. The cancel bug gets a failing test first.
4. **Generator in round 3,** extracted from the code once 1 to 3 are applied. Guide pages for what exists are written in this step.

## Round 2: the code (agreed)

### Moves

| Layer | Public modules | `internal/` |
| --- | --- | --- |
| `ai` | `Models.ts` (+ `ConversationId`), `Catalog.ts`, `Routes.ts`, `Credential.ts`, `ModelProfile.ts`, `Login.ts` | `catalog/` models-dev, live-models, snapshot; `login/` token-endpoint, chatgpt-app; `protocols/` messages-defaults, responses-stream, openai-decisions, structured-output; `signing/` route-auth, claude-code |
| `core` | `Agent.ts` (+ `RunOptions`), `Client.ts` (commands, events) | `loop/` step, one file per operation, reply; `run-tool/` run-tool, soul |
| `session` | `Sessions.ts`, `Entry.ts`, `ContextView.ts` | |
| `host` | `Settings.ts`, `CredentialStore.ts`, `CatalogCache.ts`, `HostId.ts` | |
| `database` | `Database.ts`, `TauHome.ts` | |
| `proc`, `sandbox` | `Command.ts`, `Sandbox.ts` | |
| `cli` | `main.ts` | `print.ts`, `login.ts`, `failure.ts` |
| `tests/` | `tests/<layer>/<flow>.test.ts`; `support/` and `recordings/` stay | |

Tests import only public modules, with one exception until the HTTP fake provider exists: the login tests read signed headers from the internal signer (`tests` may import `ai-internal`). Two tests do not use public modules today: `tests/support/login-harness.ts` uses the internal `credentialSigner`, and `tests/chatgpt-app.test.ts` uses `logInChatgptApp`. The ChatGPT app test changes to call `Login`; the signer helper stays until the fake provider replaces it.

### Fallow zones

```jsonc
{ "name": "ai", "patterns": ["src/ai/*.ts"] },
{ "name": "ai-internal", "patterns": ["src/ai/internal/**"] },
// …the same pair for every layer
{ "from": "ai", "allow": ["ai-internal"] },
{ "from": "ai-internal", "allow": ["ai"] },
// existing rules name only public zones, so other layers and tests cannot reach internal/
```

### Services a layer needs, provided from outside

`ai` declares what it needs, and `host` implements it on `~/.tau`, as the credential store already works:

```ts
// database/TauHome.ts: where Tau keeps its files; cli provides ~/.tau, tests a temp directory
class TauHome extends Context.Service<TauHome, { readonly directory: string }>()("tau/database/TauHome") {}

// ai declares; host implements
CredentialStore  (exists)   CatalogCache (exists)
RouteTable       new: routes and route settings, which catalogLayer takes as an argument today
HostId           new: the Sign in with ChatGPT host ID, which cli reads and passes today
LoginPrompt      grows: also asks for an API key and the login method
```

`Login.ts` becomes one deep module, `logIn(route)` and `logOut(route)`, for every kind of login. The branching on login kind and the ChatGPT revoke now in `cli/login.ts` move into it, so `cli` only shows prompts.

### The agent runner

```ts
interface Agent {
  // The session stays open for runs until the caller's scope closes
  open(target: Option<SessionId>, directory: string):
    Effect<OpenSession, SessionNotFound | SessionStoreError, Scope>
}
interface OpenSession {
  readonly session: Session
  readonly subscribe: Effect<Subscription<AgentEvent>, never, Scope>
  send(command: Command): Effect<void>   // a prompt carries its RunOptions, so a client can change the model between prompts
}
```

```text
open:     RcMap.get(runners, session id); two clients of one session share one runner
runner:   prompts = Queue; current = FiberHandle; events = PubSub
          worker fiber: loop { prompt = take prompts; run = FiberHandle.run(current, runPrompt(prompt)); publish run-ended(await run) }
send:     prompt → offer to the queue
          cancel → take the waiting prompts off the queue (Queue.clear), publish prompts-returned with them,
                   then FiberHandle.clear(current), which interrupts the running prompt
          the TUI puts returned prompts back in the editor; print mode never has any
```

This removes the hand-built map, the semaphore and the "current fiber" reference. It also removes `Effect.orDie` for an unknown session, because a client can only send through a session it opened.

### Smaller changes

```text
proc/Command.ts   spawner.spawn(ChildProcess.make("sh", ["-c", command], { cwd, forceKillAfter }))
                  handle.all |> decodeText |> fold with the 50,000-character cap; handle.exitCode; timeoutOption
                  closing the scope stops the process group; Bun.spawn and killGroup are deleted
core reply        partial parts in a Ref; read by the interrupt handler
sandbox replace   ReplaceFailed tagged error
saves on cancel   Effect.ignore({ log: true })
cli print         Stdio.stdout, Stdio.stdin; BunServices.layer provides Stdio and ChildProcessSpawner
```

### Order (checks pass after each)

1. Test: two prompts, then a cancel, stops the running one. It fails today.
2. Moves and zones only, with no behavior change.
3. `TauHome`, `RouteTable`, `HostId`, the `Login` module, and layers on the service classes.
4. The runner. Test 1 passes.
5. `proc` on `ChildProcessSpawner`. The existing timeout and cancel tests prove it.
6. The smaller changes, then guide pages: `print-mode.md`, `choose-a-model.md`, `log-in.md`, `settings.md`.
