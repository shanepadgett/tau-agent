# Subagent cmux observability remediation

Status: implemented

## Decision

Do not keep the current implementation. Preserve the user goal: when Tau runs interactively inside cmux, show live progress for delegated subagents beside the parent terminal. Replace the per-call pane implementation with one session-owned dashboard and harden the subagent runtime before wiring the dashboard into it.

The current diff is trying to do four things:

1. Detect cmux from `CMUX_WORKSPACE_ID` and `CMUX_SURFACE_ID`.
2. Open one live Markdown surface for every subagent invocation, including queued calls.
3. Update each surface from `SubagentDetails` while the child runs.
4. Keep sibling surfaces until all of them finish, then close the group after two seconds.

That UX is understandable. The ownership model is unsafe. Optional presentation work now sits on the scheduling path, module-global cmux state outlives Tau sessions, and one slow child can retain every completed pane. Reworking only the cleanup code would leave the core lifecycle races in place.

## Review findings

### 1. Session lifecycle does not own cmux lifecycle

`packages/agent/extensions/subagent/cmux-panel.ts` stores `openSurfaces`, `livePanels`, and `opChain` at module scope. `packages/agent/extensions/subagent/index.ts` resets child threads on `session_start` and `session_shutdown`, but it cannot reset, abort, or await the panel manager.

Consequences:

- A reload or new session can inherit stale surface IDs and delayed teardown work.
- Old and new calls can be grouped despite belonging to different parent sessions or workspaces.
- A panel open that completes after shutdown can create an orphan surface.
- A failed close is forgotten because `teardownAllPanels()` clears ownership before attempting the close.

### 2. Presentation blocks scheduling and weakens thread safety

`index.ts` awaits `openCmuxSubagentPanel()` before reserving a retained thread and before acquiring the four-call global gate. Panel opening serializes `ping`, `markdown open`, and workspace equalization, each with a 2.5 second timeout.

Consequences:

- A continuation can hold an unreserved `SubagentThread` while a fresh call evicts and disposes it.
- Arbitrarily many parallel calls can create surfaces and temporary directories even though only four children may run.
- cmux latency delays the native waiting update and child admission.
- The two-second close delay runs inside the cmux operation chain, so a later call can wait for an unrelated dashboard teardown before starting its own panel work.

Optional observability must never control whether or when a child runs.

### 3. The global pane cohort has no useful boundary

Every live panel in the Node process belongs to one group. A completed panel remains open while any tracked child is running. One hung child therefore retains all completed panes and files. Later unrelated invocations join the same group. A user manually closing the first surface also leaves `openSurfaces[0]` stale, causing later splits to target a missing surface.

The four-child runtime limit does not bound this group because panes open before admission.

### 4. Cleanup can leave broken or orphaned surfaces

All cmux errors are reduced to `{ ok: false }`. If `markdown open` succeeds in cmux but the CLI response times out or contains malformed JSON, Tau deletes the backing directory without knowing which surface to close. During teardown, Tau removes the backing file even when `close-surface` fails. cmux can then retain a Markdown surface that points at a missing file.

Cleanup must remain idempotent, preserve ownership until close succeeds or the workspace is known to be gone, and keep the file while a surface may still reference it.

### 5. Workspace-wide equalization is too invasive

The implementation calls `workspace.equalize_splits` after every open and after group teardown. That operation resizes the whole workspace, including panes Tau does not own. Opening a status view does not justify rewriting the user's layout.

### 6. Agent names are unsafe filesystem components

Agent validation requires a non-empty name but permits `/`, `..`, and arbitrarily long values. `cmux-panel.ts` interpolates the name into the Markdown path. For example, `../escaped` resolves outside the private temporary directory. Cleanup then removes the generated directory and leaves the escaped file behind.

Use a fixed filename. Identity belongs in the document, not its path.

### 7. Activation is too broad and undocumented

The panel opens whenever cmux environment variables exist. It does not check `ctx.mode`, `ctx.hasUI`, or whether the invocation is an interactive parent session. Print-mode automation launched from a cmux terminal can therefore mutate the visible workspace.

This is user-facing behavior, but the extension README, custom-subagent documentation, and Tau help do not describe it.

### 8. The live response freezes after roughly 600 characters

Streaming response text is head-capped in `run.ts`. Once the response exceeds `PREVIEW_LIMIT`, repeated panel updates contain the same first 599 characters and an ellipsis. The cmux formatter allows 3,000 characters, but it never receives a changing tail. Long responses appear stuck until the terminal update replaces the preview with final output.

### 9. Tests cover formatting instead of behavior

The new test checks two Markdown strings. It does not exercise process execution, command arguments, JSON parsing, timers, write ordering, layout ownership, overlapping calls, close failures, session reset, or shutdown. Direct `execFile` calls and module-global state make those paths hard to test.

The targeted subagent tests currently pass. Their six assertions do not reach the integration risks above.

## Existing runtime defects to fix in the same redesign

The cmux diff exposes older subagent lifecycle problems. Leaving them in place would make the new dashboard reliable while the children beneath it remain racy.

### Retention capacity is not atomic

The 16-thread capacity check, eviction, asynchronous creation, and insertion are separate operations. Concurrent fresh calls can all observe spare capacity and exceed the limit. Starting from a full map, one call can remove an eviction candidate and yield while the other calls observe a size below the limit.

### Failed initial turns become reusable threads

A fresh thread enters the registry before its initial turn. `runSubagentTurn()` converts child failures into normal results, and `index.ts` advertises the thread for reuse regardless of status. Failed and aborted initial turns consume retention capacity and skip bootstrap instructions on a later continuation.

### Reset and shutdown do not fence in-flight startup

Execution controllers are registered only after discovery and settings work. Child startup checks cancellation once, then awaits resource loading, session creation, and extension binding. A reset during those awaits can let an old call publish a thread into the new session's registry. Resetting the numeric thread counter makes the collision worse.

## Target architecture

### A. Session-scoped `SubagentRuntime`

Add `packages/agent/extensions/subagent/runtime.ts`. The extension factory creates exactly one runtime and disposes it on session reset or shutdown.

The runtime owns:

- the four-call FIFO scheduler;
- retained thread entries;
- in-flight startup reservations;
- per-thread turn queues;
- active invocation controllers and promises;
- thread ID generation;
- the current lifecycle generation;
- immutable invocation snapshots for observers.

Register an invocation and its controller synchronously at the start of `execute`, before discovery or settings reads. Every asynchronous boundary must re-check the signal and lifecycle generation before publishing state.

Use non-repeating IDs for the extension lifetime. Do not reset IDs on `session_start`.

### B. Transactional retained threads

Treat a fresh child as provisional:

1. Reserve retention capacity atomically, counting in-flight startups.
2. Create the child session.
3. Run the initial delegated turn.
4. Publish the thread to the reusable registry only after a completed initial turn.
5. Dispose the provisional child and release capacity on startup failure, abort, terminal error, or empty output.

Reserve an existing thread synchronously before any observer or UI await. Eviction may choose only an idle, unreserved thread.

Continuation failures need an explicit health rule. Keep a thread after a normal model-level abort or terminal error only when the `AgentSession` remains usable. Dispose it after startup, binding, prompt, or session-state failures.

### C. Generic snapshot observer

Keep cmux out of `run.ts`. `runSubagentTurn()` already has an update callback; make it publish immutable `SubagentInvocationSnapshot` values through a runtime observer.

Each snapshot must include a unique invocation ID in addition to the retained thread ID. Two queued continuations of the same thread must remain distinguishable.

Required lifecycle states:

- `waiting`
- `starting`
- `running`
- `completed`
- `failed`
- `aborted`

The tool adapter and the cmux adapter consume the same snapshots. The runner must not import a presentation-specific type.

Use a rolling tail for streaming response previews so progress continues to change after 600 characters. Preserve complete final output and existing truncation behavior separately.

### D. One cmux dashboard per active cohort

Replace `cmux-panel.ts` with `cmux-dashboard.ts`, owned by the extension factory. One Markdown surface displays every waiting and running invocation. This gives immediate queue visibility with a hard bound of one surface and one temporary directory.

Dashboard behavior:

1. Enable only when `ctx.mode === "tui"`, `ctx.hasUI` is true, and both cmux IDs are present.
2. Capture the parent workspace and surface IDs once for the Tau session.
3. On the first invocation, create a private temporary directory containing a fixed `dashboard.md` filename.
4. Open one right-side Markdown surface without focus.
5. Render all invocation snapshots into that file, ordered by invocation start time.
6. Debounce and coalesce writes. Never await dashboard work from the child scheduler.
7. After the active invocation map becomes empty, start a two-second close timer outside the cmux command queue.
8. Cancel that timer if another invocation arrives.
9. Close only the owned surface. Do not equalize the workspace.
10. On session reset or shutdown, cancel timers, stop accepting snapshots, flush final state, close the owned surface, and clean the directory.

If cmux open fails, disable the dashboard for that Tau session and notify once. Subagent execution must continue unchanged.

### E. cmux command boundary

Use `pi.exec`, consistent with other Tau extensions. Inject the command function and clock into the dashboard for tests.

Prefer the cmux socket methods through `cmux rpc`:

- `markdown.open` with explicit `path`, `workspace_id`, `surface_id`, `direction: "right"`, and `focus: false`;
- `surface.close` with the recorded workspace and surface IDs.

This avoids shell flag drift and removes the extra `ping`. The open call itself is the capability probe. Parse and validate the complete response before storing ownership.

The installed cmux 0.64.20 accepts `--focus false`; that flag is not a defect in the current diff. The redesign uses RPC because it is a cleaner programmatic boundary.

## Implementation slices

Each slice must leave the repository green and contain no dead exports or staged files.

### Slice 1: Harden the core runtime

- Add `runtime.ts` with session generation, active invocation tracking, global scheduling, atomic startup reservations, and retained-thread ownership.
- Move orchestration out of `index.ts`; leave tool registration and rendering there.
- Register cancellation before discovery.
- Fence late startup completion after reset and shutdown.
- Publish fresh threads only after a successful initial turn.
- Return reuse instructions only when a thread was retained.
- Keep `createSubagentThread()`, `runSubagentTurn()`, and `disposeSubagentThread()` as low-level session operations used by the runtime and the ephemeral context-sync path.

Tests:

- concurrent fresh calls never exceed 16 retained or reserved slots;
- a continuation reserved before an await cannot be evicted;
- failed and aborted initial turns are disposed and not advertised;
- reset during discovery, resource loading, session creation, and extension binding cannot publish into the next generation;
- shutdown aborts active calls and disposes each created session exactly once;
- queued calls retain FIFO order and same-thread turns remain sequential.

### Slice 2: Introduce invocation snapshots

- Add the invocation ID and explicit lifecycle state model.
- Fan immutable snapshots to the native tool update callback.
- Remove all cmux imports from `run.ts`.
- Publish a terminal assistant-message snapshot before final accounting without duplicating terminal state.
- Make streaming previews show the latest response tail.

Tests:

- snapshots follow valid state transitions;
- two continuations of one thread have distinct invocation IDs;
- snapshot mutation by one observer cannot affect another;
- long streaming responses continue changing past the preview limit;
- an already-aborted signal never starts a prompt;
- a rejected `session.abort()` does not create an unhandled rejection.

### Slice 3: Build the session-owned cmux dashboard

- Add `cmux-dashboard.ts` with injected `pi.exec` and clock boundaries.
- Use one fixed Markdown file and one owned surface.
- Track active snapshots by invocation ID.
- Keep timers outside the serialized open/close queue.
- Make shutdown and cleanup idempotent.
- Remove the current per-call `CmuxSubagentPanel` API and formatter test.

Tests with a fake cmux client and fake clock:

- outside cmux and print mode are no-ops;
- the first invocation opens exactly one surface with explicit parent IDs and `focus: false`;
- later parallel and queued calls update the same document;
- opening never blocks runtime admission;
- a call arriving during the close grace period cancels teardown;
- close targets only the owned surface and never equalizes the workspace;
- malformed open output, timeout, and close failure preserve safe ownership and backing-file behavior;
- shutdown during opening, writing, grace delay, and closing leaves no runnable timers or unhandled promises;
- task, action, and response content cannot alter filesystem paths.

### Slice 4: Document and validate the behavior

- Update `packages/agent/extensions/subagent/README.md`.
- Update `packages/agent/docs/subagents.md`.
- Update the `subagent` entry in `packages/agent/extensions/tau-help/help.md` because basic visible behavior changes inside cmux.
- State that the dashboard is interactive-cmux-only, uses one temporary Markdown surface, does not affect child execution, and closes after the active cohort finishes.
- Test manually after `/reload`, as required for extension changes.

Manual scenarios:

1. One successful fresh subagent.
2. Four running calls plus queued calls.
3. Two continuations submitted to the same thread.
4. One fast child and one long child.
5. Child failure and user abort.
6. Tau `/reload` while a child is starting and while one is running.
7. Parent cmux surface or workspace closed manually.
8. cmux unavailable, unsupported, or returning malformed output.
9. Print-mode Tau launched from a cmux terminal.

## Acceptance criteria

- Subagents behave exactly as before outside interactive cmux.
- cmux latency or failure cannot delay, fail, or reorder child work.
- At most four child turns run concurrently.
- Retained plus reserved thread capacity never exceeds 16.
- Failed initial turns are never reusable.
- No execution from an old session can publish a thread or dashboard update into a new session.
- At most one Tau-owned Markdown surface exists per parent session.
- Tau never calls workspace-wide layout equalization.
- Every owned timer, child session, surface, and temporary directory has one session-scoped owner and idempotent cleanup.
- The meaningful async and lifecycle paths are covered with fakes; formatting-only tests are insufficient.

## Out of scope

- Running child Pi TUIs in separate terminal processes.
- Persisting subagent threads across parent Tau sessions.
- A public subagent event API for third-party extensions.
- New user settings or layout modes.
- Generic cmux task-manager integration.

Those can be designed later if actual use demands them. The remediation should solve the current live-observability goal without creating another extension framework inside the subagent extension.
