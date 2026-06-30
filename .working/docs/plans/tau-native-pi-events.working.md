# Tau Native Pi Events Working Notes

## Rough shape

Tau Agent is a Pi extension pack/harness. Public extension integration should use Pi's event bus directly: `pi.events.emit(channel, payload)`.

Tau should not maintain a second event bus. `src/shared/events.ts` may keep type registry and thin typed passthrough helpers for Tau's own code only.

External callers should not import Tau internals. The contract is docs plus Pi event names/payloads.

## Repo facts

- Pi event bus API is `emit(channel: string, data: unknown): void` and `on(channel: string, handler: (data: unknown) => void): () => void`; see `node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.d.ts:1-8`.
- Pi `createEventBus()` catches handler errors inside the bus; see `node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js:8-19`.
- Current Tau event types live in `src/shared/events.ts:4-40`.
- Current Tau private bus lives in `src/shared/events.ts:48-100` and uses a global WeakMap, so direct `pi.events.emit(...)` bypasses Tau listeners.
- `tau:autoread.requested` currently pins `source` to `"tau-context"`; see `src/shared/events.ts:24-30` and `src/extensions/explore/autoread.ts:12-18`.
- Autoread subscribes through `onTauEvent()` and reads files from `cwd + path`; see `src/extensions/explore/autoread.ts:22-53`.
- Autoread renderer rejects saved details unless `source === "tau-context"`; see `src/extensions/explore/autoread.ts:70-88`.
- Footer state uses `tau:footer-item`; see `src/extensions/footer/index.ts:152-167`.
- Tool-row state uses `tau:tool-row-state.set`; see `src/shared/tool-row-state.ts:14-21`.
- Attention uses `tau:agent.blocked`; see `src/extensions/attention/index.ts:25-68`.
- Patch emits `tau:file-mutation.applied`; see `src/extensions/patch/index.ts:172-190`.
- Local `.pi` extensions import Tau helpers: `.pi/extensions/tau-context/index.ts:86-92`, `.pi/extensions/bash-toggle/index.ts:1-32`, `.pi/extensions/bash-toggle/index.ts:86-88`, `.pi/extensions/system-prompt-viewer/index.ts:1-34`.
- Current tool-row test fakes only `events.emit`, which will break when `onTauEvent()` delegates to `pi.events.on`; see `test/shared/tool-row-state.test.ts:15-17`.
- Soul prompt injects Pi docs guidance in `src/extensions/soul/prompt.ts:63-71` and `src/extensions/soul/prompt.ts:123-132`.
- Tau package has no `docs/` directory yet; `package.json:11-23` exposes extensions/skills/prompts/themes only.

## Decisions

- Delete Tau runtime event infrastructure.
- Keep `TauAgentEvents`, `emitTauEvent()`, `onTauEvent()`, and `setTauFooterItem()` only if they stay typed passthrough/domain helpers over `pi.events`.
- Change `emitTauEvent()` to return `void`, because Pi emit returns `void`.
- Remove `await emitTauEvent(...)` call sites.
- Widen autoread `source` to `string`.
- Validate public autoread payload at the listener boundary. Bad event payloads do not throw through emitters.
- Public docs file should be `docs/extending-tau-agent.md`, not `docs/events.md`.
- Soul prompt should compute Tau docs path from the installed Tau package location, not process cwd.
- No Tau SDK package now. The first public integration surface is documented Pi events.

## Compared designs

### Delete all Tau event helpers

Purest Pi usage. Every Tau file calls `pi.events.emit/on` directly.

Cost: repeated channel strings and untyped internal payloads. Less useful grep/type registry.

### Keep typed passthrough helpers

`src/shared/events.ts` stays as one type map plus dumb wrappers. Runtime behavior is entirely Pi's bus.

Cost: tiny wrapper remains.

Accepted. The wrapper name/type map earns keep by centralizing internal event contracts without owning dispatch.

## Cleanup candidates

- Delete `HandlerStore`, `TauEventGlobal`, `tauEventGlobal`, and `handlersByBus` from `src/shared/events.ts`.
- Delete stale simple plan `.working/docs/plans/tau-events-docs-and-autoread.plan.md`; replaced by this full plan set.

## Open

None blocking.
