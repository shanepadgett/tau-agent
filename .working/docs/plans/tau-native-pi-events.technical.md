# Tau Native Pi Events Technical Plan

## References to read first

Read these ranges before editing. Read more only if the range changed or becomes insufficient.

- `src/shared/events.ts:4-40` for the event type map.
- `src/shared/events.ts:48-100` for the custom bus to delete.
- `node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.d.ts:1-8` for the Pi event bus API.
- `node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js:8-19` for Pi's handler error behavior.
- `src/extensions/explore/autoread.ts:12-88` for autoread event handling and detail parsing.
- `src/shared/tool-row-state.ts:14-21` for tool-row event subscription.
- `src/extensions/footer/index.ts:152-167` and `src/extensions/footer/index.ts:214-220` for footer event subscription and unsubscribe.
- `src/extensions/attention/index.ts:25-68` for blocked notification subscription.
- `src/extensions/patch/index.ts:172-190` for patch event emit.
- `.pi/extensions/tau-context/index.ts:78-92` for autoread emit.
- `.pi/extensions/bash-toggle/index.ts:1-32` and `.pi/extensions/bash-toggle/index.ts:86-88` for footer item emits.
- `.pi/extensions/system-prompt-viewer/index.ts:1-34` for footer item emit.
- `src/extensions/soul/prompt.ts:1-8`, `src/extensions/soul/prompt.ts:63-71`, and `src/extensions/soul/prompt.ts:123-132` for docs prompt injection.
- `test/shared/tool-row-state.test.ts:1-40` for the fake event API that must change.

## Code Ladder result

Need exists: yes. External Tau users cannot trigger autoread through Pi events while Tau listens only to a private bus.

Repo already has code: yes. Keep `src/shared/events.ts` as internal type registry/passthrough; replace dispatch implementation.

Small refactor first: yes. Delete private bus before changing callers/tests.

Stdlib/platform/dependency: Pi already provides `pi.events`; use it.

One line works: mostly. The core refactor is two wrapper bodies plus deleting private storage. Autoread validation/docs/prompt need small code.

## Target shape

`src/shared/events.ts` owns compile-time Tau event names/payloads only.

Runtime event ownership belongs to Pi:

```ts
export function emitTauEvent<Name extends keyof TauAgentEvents>(
 pi: EventAPI,
 name: Name,
 data: TauAgentEvents[Name],
): void {
 pi.events.emit(name, data);
}

export function onTauEvent<Name extends keyof TauAgentEvents>(
 pi: EventAPI,
 name: Name,
 handler: TauEventHandler<Name>,
): () => void {
 return pi.events.on(name, handler as (data: unknown) => void);
}
```

No `WeakMap`. No `globalThis.__tauAgentEventHandlers`. No manual handler fan-out. No manual error catching in Tau event helpers.

## File changes

### `src/shared/events.ts`

Change `TauAgentEvents["tau:autoread.requested"].source` from `"tau-context"` to `string`.

Keep these exports:

- `TauAgentEvents`
- `TauFooterItem`
- `emitTauEvent`
- `onTauEvent`
- `setTauFooterItem`

Delete these private runtime pieces:

- `HandlerStore`
- `TauEventGlobal`
- `tauEventGlobal`
- `handlersByBus`
- every Map/Set handler registration branch inside `onTauEvent()`
- Promise fan-out and `console.error` block inside `emitTauEvent()`

Change `emitTauEvent()` return type from `Promise<void>` to `void`.

Keep `TauEventHandler` accepting `void | Promise<void>`. Pi's event bus handles async handler errors.

### `src/extensions/explore/autoread.ts`

Change `AutoreadDetails.source` from `"tau-context"` to `string`.

Add a small boundary reader near `readDetails()`:

```ts
function readAutoreadRequestedEvent(value: unknown): TauAgentEvents["tau:autoread.requested"] | undefined
```

Rules:

- value must be object
- `source`, `cwd`, and `batchId` must be strings
- `title`, when present, must be string
- `files` must be an array
- each file must be object with string `path`

In the listener, validate first:

```ts
onTauEvent(pi, "tau:autoread.requested", async (data) => {
 const event = readAutoreadRequestedEvent(data);
 if (!event) return;
 ...
});
```

Keep missing/unreadable files as per-file failed messages.

Update `readDetails()` to accept any string `source` instead of only `"tau-context"`.

Do not document or expose `tau.autoread` custom message details as public API in this change.

### Emit call sites

Because `emitTauEvent()` becomes `void`, remove `await` from current emit call sites.

Update:

- `src/extensions/patch/index.ts:176`
- `.pi/extensions/tau-context/index.ts:86`

No behavior should depend on waiting for event handlers. Pi events are fire-and-forget.

Keep `src/shared/agent-blocked.ts` as a domain helper around `emitTauEvent()`.

Keep `setTauFooterItem()` because it names the footer item domain event and is reused by multiple extensions.

### Tests

Add `test/shared/events.test.ts`.

Use Pi's real `createEventBus()` exported by `@earendil-works/pi-coding-agent`. Do not keep a fake that implements only `emit`.

Test cases:

1. `onTauEvent(pi, "tau:autoread.requested", handler)` receives an event sent by `emitTauEvent(pi, "tau:autoread.requested", payload)`.
2. The same listener receives an event sent directly by `pi.events.emit("tau:autoread.requested", payload)`.
3. The unsubscribe returned by `onTauEvent()` stops later delivery.

Use synchronous handlers so assertions do not depend on async emit completion.

Update `test/shared/tool-row-state.test.ts`:

- import `createEventBus`
- make `eventApi()` return `{ events: createEventBus() }`
- remove `await` before `emitTauEvent(...)`

Do not add broad extension integration tests unless the small event tests fail to cover the refactor.

### `docs/extending-tau-agent.md`

Create `docs/` and add one short doc.

Keep it product-level and small. This is a contract, not an implementation tour.

Required content:

- Tau Agent is a Pi extension harness.
- External integration uses Pi's native `pi.events` bus.
- Caller and Tau Agent must be loaded in the same Pi runtime.
- External callers use string channel names and documented payloads; they do not import Tau internals.
- Only events documented in this file are public.
- Extensions run trusted in-process; event emitters can ask Tau Agent to do work.
- `tau:autoread.requested` payload, behavior, and tiny example.

Document this payload:

```ts
pi.events.emit("tau:autoread.requested", {
 source: "my-extension",
 title: "Skill context",
 cwd: ctx.cwd,
 batchId,
 files: [{ path: "skills/foo/SKILL.md" }],
});
```

Document fields:

- `source`: caller identifier shown in Tau metadata.
- `title`: optional display/context label.
- `cwd`: root used to resolve file paths.
- `batchId`: groups visible autoread messages.
- `files[].path`: file path relative to `cwd`.

Document behavior:

- Tau reads each requested file.
- Tau injects visible `tau.autoread` messages.
- Missing/unreadable files produce visible failed autoread messages.
- `pi.events.emit(...)` does not return file contents and should not be treated as completion/ack.

Do not include SDK package promises, future events, or internals.

### `src/extensions/soul/prompt.ts`

Add Tau docs guidance beside Pi docs guidance in `buildRokPrompt()`:

```ts
formatPiDocsGuidance(),
formatTauDocsGuidance(),
```

Compute Tau docs path from the installed package, not `runtimeContext.cwd` and not `process.cwd()`.

Use `import.meta.url` as the anchor. Small helper shape:

```ts
function getTauDocsPath(): string {
 return join(resolveTauPackageRoot(), "docs");
}
```

Preferred root resolution:

- start at `dirname(fileURLToPath(import.meta.url))`
- walk up parent directories
- first `package.json` whose parsed `name` is `"tau-agent"` is the root
- fallback to `resolve(dirname(fileURLToPath(import.meta.url)), "../../..")` if no verified package root is found

Imports likely needed:

- `existsSync`, `readFileSync` from `node:fs`
- `dirname`, `join`, `resolve` from `node:path`
- `fileURLToPath` from `node:url`

Prompt text should be short:

```txt
Tau Agent documentation (read only when the user asks about Tau Agent, Rok, Tau extensions, Tau event APIs, harness behavior, or extending Tau Agent):
- Tau Agent docs: <path>
- For external Tau Agent integration, read docs/extending-tau-agent.md first
- Resolve Tau docs/... under Tau Agent docs, not the current working directory
- Do not read Tau Agent docs for normal coding tasks
```

Do not make Tau docs guidance mention future docs that do not exist.

## Order of implementation

1. Edit `src/shared/events.ts` to Pi passthrough only and widen autoread `source`.
2. Update emit call sites to remove `await`.
3. Update tests to use `createEventBus()` and add event sharing tests.
4. Add autoread boundary validation and `source: string` detail parsing.
5. Add `docs/extending-tau-agent.md`.
6. Add Tau docs guidance to `src/extensions/soul/prompt.ts`.
7. Grep `emitTauEvent`, `onTauEvent`, `TauAgentEvents`, `setTauFooterItem`, and `__tauAgentEventHandlers` to confirm no private bus remains and no stale awaits remain.

Do not run `mise run check:ts` or `mise run check:md`; automatic commands own that.

## Edge cases

- Direct `pi.events.emit(...)` with bad payload must not throw through the emitter.
- Direct `pi.events.emit(...)` with valid payload must reach `registerAutoread()` through Pi's bus.
- Existing internal emitters still compile with typed payloads.
- `source` values other than `"tau-context"` must render in autoread details.
- Empty `files` array should do nothing.
- Missing files and permission errors should keep current failed-message behavior.
- Async handlers are fire-and-forget from the emitter's perspective.

## Manual checks after `/reload`

1. Run `/tau-context` in the Tau Agent repo, select one resource, and confirm autoread messages appear.
2. Load a tiny external extension in the same Pi runtime that calls `pi.events.emit("tau:autoread.requested", { source: "external-test", title: "External autoread test", cwd: ctx.cwd, batchId: randomUUID(), files: [{ path: "README.md" }] })`.
3. Run its command and confirm Tau reads `README.md` into a visible autoread message.

## Done

- No Tau private event bus remains.
- Tau internal event helpers are typed passthroughs over Pi events only.
- External Pi extensions can trigger autoread through documented `pi.events.emit(...)`.
- `source` accepts real external caller names.
- Autoread validates public event payloads at runtime.
- Public docs exist at `docs/extending-tau-agent.md` and stay short.
- Rok prompt points to installed Tau docs for Tau-specific work.
- Existing `/tau-context` and footer item behavior still work after reload.
