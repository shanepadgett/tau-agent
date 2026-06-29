# Tau Events Docs and External Autoread Plan

## Goal

Make Tau Agent events usable from external Pi packages/extensions, then document the public event surface so agents working outside this repository can discover how to trigger Tau Agent behavior.

First use case: a skills-only package wants to select local skills, then ask Tau Agent `autoread` to read those files into conversation context.

## Current Facts

- Pi exposes a shared extension event bus on `pi.events`.
- Type shape from Pi: `pi.events.emit(channel: string, data: unknown): void` and `pi.events.on(channel: string, handler: (data: unknown) => void): () => void`.
- Tau currently wraps events in `src/shared/events.ts`.
- `emitTauEvent()` calls `pi.events.emit(...)`, then also dispatches through a Tau-private global WeakMap.
- `onTauEvent()` only subscribes to the Tau-private WeakMap.
- Consequence: external packages can call `pi.events.emit("tau:autoread.requested", data)`, but Tau autoread listeners registered through `onTauEvent()` will not receive that event.
- `src/extensions/explore/autoread.ts` subscribes to `"tau:autoread.requested"` through `onTauEvent()`.
- `.pi/extensions/tau-context/index.ts` emits `"tau:autoread.requested"` after selecting resources.

## Public Event Needed Now

Document and support:

```ts
pi.events.emit("tau:autoread.requested", {
 source: "tau-context",
 title: "Skill context",
 cwd: ctx.cwd,
 batchId,
 files: selectedFiles.map((path) => ({ path })),
});
```

Payload:

```ts
interface TauAutoreadRequestedEvent {
 source: "tau-context";
 title?: string;
 cwd: string;
 batchId: string;
 files: Array<{ path: string }>;
}
```

Semantics:

- `cwd` is the root for resolving relative file paths.
- `files[].path` is relative to `cwd`.
- `batchId` groups visible autoread messages.
- `title` is display/context metadata.
- Tau reads each file and injects visible `tau.autoread` custom messages.
- Missing/unreadable files produce failed autoread messages instead of throwing through the external caller.

Open naming decision:

- Keep `source: "tau-context"` for compatibility, even when external callers are not Tau context.
- Or widen to `source: string` / named literals. If widened, update `TauAgentEvents`, autoread details parsing, and docs together.

## Implementation Plan

### 1. Use Pi event bus as the shared Tau event bus

Edit `src/shared/events.ts` so `onTauEvent()` subscribes to `pi.events.on(...)`.

Smallest target shape:

```ts
export async function emitTauEvent<Name extends keyof TauAgentEvents>(
 pi: EventAPI,
 name: Name,
 data: TauAgentEvents[Name],
): Promise<void> {
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

Then delete the private global WeakMap machinery if no tests require it.

Why: Pi already owns cross-extension/package communication. Tau should not maintain a second invisible bus that external packages cannot reach.

### 2. Test event sharing

Add or update tests around `src/shared/events.ts`:

- `onTauEvent(pi, "tau:autoread.requested", handler)` receives events emitted by `emitTauEvent(pi, ...)`.
- `onTauEvent(pi, "tau:autoread.requested", handler)` receives events emitted directly with `pi.events.emit("tau:autoread.requested", payload)`.
- unsubscribe returned by `onTauEvent()` stops delivery.

Use the existing Pi `createEventBus()` if available in test setup, or a tiny fake with `emit/on` if current tests already do that.

### 3. Add Tau event docs

Create `docs/events.md`.

Include:

- Purpose: public Tau Agent event channels for other Pi packages/extensions.
- Warning: events are in-process only; caller and Tau Agent package must be loaded in the same Pi runtime.
- Basic usage example with `pi.events.emit(...)`.
- Event stability note: only events documented in `docs/events.md` are intended for external use.
- `tau:autoread.requested` section with payload, behavior, and example.
- Note that callers do not import Tau internals; use string channel plus documented payload.

Keep docs short. This is a contract, not an implementation tour.

### 4. Inject Tau docs location into Rok prompt

Soul already injects Pi docs guidance in `src/extensions/soul/prompt.ts` through `formatPiDocsGuidance()`.

Add similar Tau Agent docs guidance, probably beside Pi docs guidance:

```ts
function formatTauDocsGuidance(): string {
 return `Tau Agent documentation (read only when the user asks about Tau Agent, Rok, Tau extensions, or Tau event APIs):
- Tau Agent docs: ${getTauDocsPathSomehow()}
- When asked about external Tau event APIs, read docs/events.md first`;
}
```

Need decide how to compute docs path:

- Best: derive from this package source/install root at runtime, then point at `<package-root>/docs`.
- Avoid hardcoding user paths.
- Avoid adding config for fixed package location.

Possible mechanism:

- Use `import.meta.url` from `src/extensions/soul/prompt.ts` and walk up from `src/extensions/soul/prompt.ts` to repo/package root.
- In built or jiti-loaded package, verify path shape before relying on it.
- If there is already a shared package-root helper, reuse it. Do not add one unless needed by more than this prompt code.

Prompt text should say:

- Read Tau docs only when the user asks about Tau Agent itself, its extensions, events, docs, or harness behavior.
- For external event integration, read `docs/events.md`.
- Do not read Tau docs for normal coding tasks.

### 5. Keep tau-context behavior working

After changing event delivery, `.pi/extensions/tau-context/index.ts` should still work because it uses `emitTauEvent()`.

Manual check after `/reload`:

- Run `/tau-context` in Tau Agent repo.
- Select a resource.
- Confirm autoread messages appear.

### 6. External package manual check

Use a tiny temporary extension or package loaded alongside Tau Agent:

```ts
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
 pi.registerCommand("test-tau-autoread", {
  description: "Emit Tau autoread event",
  handler: async (_args, ctx) => {
   pi.events.emit("tau:autoread.requested", {
    source: "tau-context",
    title: "External autoread test",
    cwd: ctx.cwd,
    batchId: randomUUID(),
    files: [{ path: "README.md" }],
   });
  },
 });
}
```

Expected: Tau Agent autoread reads `README.md` and shows a `tau.autoread` message.

## Later Follow-Up: Simpler Skills Context Package

After Tau event bus/docs are fixed, implement the skills-only package here.

Shape:

- Discover skills in this codebase only.
- One command, probably `/skill-context`.
- TUI uses one multi-select-like component.
- Pi TUI does not appear to have a plain built-in multi-select. `SettingsList` can serve as a small toggle list with `on/off` values and no filtering.
- No tabs.
- No typed filtering.
- On confirm, emit `tau:autoread.requested` using the documented event.
- Optionally send hidden manifest with `customType: "tau.injected-context"` only if needed after testing. Do not depend on Tau internals unless docs bless that custom message type too.

## Done When

- External Pi packages can trigger Tau autoread through documented `pi.events.emit("tau:autoread.requested", ...)`.
- `docs/events.md` exists and documents the event contract.
- Rok prompt includes Tau docs location guidance so agents know where to look when asked about Tau Agent events.
- Existing `/tau-context` still triggers autoread.
