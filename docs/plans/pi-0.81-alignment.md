# Pi 0.81 alignment

Status: implemented

## Goal

Update Tau's Pi development baseline from 0.80.10 to 0.81.0 and adopt the two 0.81 changes that affect Tau directly:

1. complete provider objects now own authentication, model discovery, filtering, and streaming behavior;
2. tool, compaction, and branch-summary usage is persisted and included in Pi's cumulative session totals.

Keep the change narrow. Pi 0.81 does not require a broad extension or TUI rewrite.

## Current state

- Root `package.json` pins `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` to `0.80.10`.
- `package-lock.json` resolves the same versions. `@earendil-works/pi-agent-core` is transitive through coding-agent.
- Published Tau packages correctly declare Pi's bundled core packages and `typebox` as wildcard peers, as required by Pi package guidance.
- `packages/agent/shared/model-fallback/index.ts` calls the temporary `@earendil-works/pi-ai/compat` global dispatcher. That dispatcher does not represent Pi 0.81's provider-owned runtime model and is marked for later removal by Pi.
- `packages/agent/extensions/subagent/run.ts` aggregates child-model usage into `SubagentDetails.usage`, but the `subagent` tool does not return Pi's top-level `usage` field.
- `packages/agent/extensions/footer/index.ts` manually counts assistant usage and `subagent` detail metadata. It omits standard tool-result, compaction, and branch-summary usage introduced by Pi 0.81.
- `packages/agent/extensions/run-summary/index.ts` also reads subagent cost from detail metadata instead of the standard tool-result usage field.
- Nested subagent sessions call `createAgentSession()` without an explicit `ModelRuntime`. Built-in providers work, but a complete provider registered by a parent extension may be absent from the child's independently created runtime.

## Decisions

### Align all direct Pi packages together

Set the three direct root development dependencies to exact `0.81.0` versions in one lockfile update:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`

Do not add a direct `@earendil-works/pi-agent-core` dependency. Tau does not import it.

Keep published Pi peer dependency ranges as `"*"`. Pi packages provide these core modules to extensions and explicitly require wildcard peers so packages do not install competing copies.

### Dispatch nested model calls through the effective provider

Remove Tau's import from `@earendil-works/pi-ai/compat`.

For each fallback candidate:

1. resolve the model from `ctx.modelRegistry`;
2. resolve its effective provider with `ctx.modelRegistry.getProvider(model.provider)`;
3. resolve request authentication through the registry;
4. carry the provider plus `apiKey`, `headers`, and `env` in `ModelCandidate`;
5. call `provider.streamSimple(model, context, options).result()`.

Allow an authenticated candidate without a string API key so ambient provider authentication can survive the migration. The provider and resolved environment own that behavior.

This makes auto-name and other fallback consumers honor complete provider extensions and removes Tau's dependency on Pi's temporary global API registry.

### Give child sessions an explicit provider runtime

When creating a subagent thread, build an explicit child `ModelRuntime` and pass it to `createAgentSession()`.

Register the effective provider selected by the parent context in that runtime. Preserve resolved runtime authentication when the parent supplied an API-key override. The child runtime should continue using Pi's normal credential store and provider auth behavior for stored, OAuth, and ambient credentials.

Do not build a second Tau provider abstraction. Use Pi's `ModelRuntime` and provider object directly.

### Persist subagent usage in Pi's standard field

Keep `SubagentDetails.usage` for rendering and subagent-specific fields such as `turns`. Add a separate full Pi `Usage` aggregate for the tool result, including:

- input, output, cache-read, and cache-write tokens;
- total tokens;
- each cost component and total cost;
- optional usage fields present on child responses where Pi's `Usage` type requires preserving them.

Return that aggregate as top-level `usage` from the `subagent` tool. Preserve it through fresh-thread, retained-thread, failed-terminal-response, and aborted-terminal-response paths whenever child model usage occurred. Queue, discovery, or startup failures with no model call return no usage.

### Mirror Pi's cumulative accounting semantics

Tau's footer should traverse `ctx.sessionManager.getEntries()`, matching Pi's built-in footer and `AgentSession.getSessionStats()` cumulative semantics. Count:

- assistant `message.usage`;
- tool-result `message.usage`;
- `compaction.usage`;
- `branch_summary.usage`.

Only assistant responses update the latest cache-hit-rate display. Tool and summary usage contributes to cumulative tokens and cost without replacing that rate.

The daily session-file scan must recognize the same usage-bearing records and use the entry timestamp for top-level compaction and branch-summary entries. Remove the special subagent-details accounting path so new sessions cannot count the same nested usage twice.

`run-summary` keeps its existing split between parent-run cost and subagent cost, but reads the latter from `ToolResultMessage.usage`.

Historical 0.80 session records are not rewritten or given a permanent compatibility branch. Their subagent usage remains in detail metadata and will no longer contribute to the revised generic footer totals. The persisted format from the supported 0.81 baseline becomes authoritative.

### Leave unrelated 0.81 features alone

No Tau source migration is needed for:

- llama.cpp management;
- Qwen Token Plan providers;
- the new RPC thinking-level command;
- package-root lifecycle event type exports;
- corrected extension examples;
- terminal, retry, catalog, and provider bug fixes;
- low-level `Agent` construction or custom `SessionStorage` changes in agent-core, because Tau uses coding-agent's SDK and `SessionManager.inMemory()` rather than those APIs directly.

Tau's current TUI imports and extension callback shapes remain available in Pi 0.81.

## Implementation slices

Each slice must leave the repository green and contain no unused exports or staged compatibility code.

### Slice 1: Update the Pi baseline

- Update the three exact versions in root `package.json` to `0.81.0`.
- Regenerate `package-lock.json` in the same operation.
- Confirm the lock resolves coding-agent's transitive Pi packages to the 0.81 line and keeps approved public npm registry sources.
- Leave both published workspace peer dependency blocks unchanged.

Files:

- `package.json`
- `package-lock.json`

### Slice 2: Migrate fallback generation to provider-owned streaming

- Extend `ModelCandidate` with the effective Pi provider and resolved environment.
- Make `apiKey` optional where Pi provider auth permits it.
- Resolve candidates only when both the model and effective provider exist and authentication succeeds.
- Replace the compat `completeSimple()` call with the provider's `streamSimple(...).result()`.
- Preserve abort signals, reasoning level, session affinity ID, headers, tools, and correction retries.
- Rewrite model-fallback tests around a fake provider stream.
- Add coverage proving a provider-specific `streamSimple` implementation is used and ambient auth does not require a fabricated API key.

Files:

- `packages/agent/shared/model-fallback/index.ts`
- `packages/agent/shared/model-fallback/types.ts`
- `packages/agent/test/shared/model-fallback.test.ts`

### Slice 3: Make child sessions provider-aware

- Construct a `ModelRuntime` during subagent thread creation.
- Register the effective selected provider from the parent registry.
- Apply a resolved runtime API-key override only when one exists.
- Pass the runtime to `createAgentSession()`.
- Keep the current model and thinking-level fallback behavior.
- Dispose the child session through the existing thread lifecycle; do not add a second runtime owner.
- Add a test where the parent-selected model belongs to an extension-registered complete provider and the child prompt reaches that provider.

Files:

- `packages/agent/extensions/subagent/run.ts`
- `packages/agent/test/extensions/subagent/run.test.ts`

### Slice 4: Persist standard subagent tool usage

- Aggregate full Pi `Usage` while collecting child assistant messages.
- Keep the compact `SubagentDetails.usage` projection used by renderers and observers.
- Add optional top-level `usage` to `SubagentToolResult` and preserve it through runtime return paths.
- Ensure failed or aborted terminal responses still report usage already incurred.
- Leave pre-model startup and scheduling failures without usage.
- Update subagent runtime tests to assert the standard usage shape survives fresh and continued calls.

Files:

- `packages/agent/extensions/subagent/run.ts`
- `packages/agent/extensions/subagent/runtime.ts`
- `packages/agent/extensions/subagent/index.ts`
- `packages/agent/test/extensions/subagent/run.test.ts`
- `packages/agent/test/extensions/subagent/runtime.test.ts`

### Slice 5: Align Tau's accounting views

- Replace footer's subagent-details special case with generic usage-bearing entry handling.
- Include tool-result, compaction, and branch-summary usage in session totals.
- Make session totals cumulative over all session entries, matching Pi 0.81.
- Update the daily file scan to parse the same records exactly once.
- Read run-summary subagent cost from tool-result usage.
- Add focused tests for each usage source and a regression proving subagent detail metadata is not counted in addition to top-level usage.

Files:

- `packages/agent/extensions/footer/index.ts`
- `packages/agent/extensions/run-summary/index.ts`
- `packages/agent/test/extensions/run-summary/index.test.ts`
- new focused footer accounting test under `packages/agent/test/extensions/footer/`

### Slice 6: Package validation

- Confirm Tau loads under Pi 0.81 with no extension diagnostics.
- Exercise auto-name fallback against a fake provider-owned stream.
- Exercise a fresh subagent and a retained-thread continuation.
- Confirm a subagent tool result persists top-level usage in session JSONL.
- Confirm footer totals change after subagent execution, `/compact`, and summarized `/tree` navigation without double counting.
- Run dry package builds for both workspaces and inspect their file lists.

Extension changes require `/reload` before interactive testing.

Do not bump Tau workspace versions, tag, publish, commit, or open a pull request as part of implementation. If a release is requested afterward, both Tau workspaces must move together because the publish workflow publishes both and `@shanepadgett/tau-agent` pins `@shanepadgett/tau-tui` exactly.

## Acceptance criteria

- Root development and lockfile Pi versions are aligned on 0.81.0.
- Tau has no import from `@earendil-works/pi-ai/compat`.
- Fallback generation executes through the effective provider object and preserves existing retry, validation, reasoning, abort, and session-affinity behavior.
- A parent-selected complete provider can serve a child subagent session.
- Every subagent model call that incurs usage is persisted on the parent tool result using Pi's standard `Usage` shape.
- Tau's footer and run summary consume standard usage fields and do not double count subagent detail metadata.
- Footer session and daily totals include tool, compaction, and branch-summary usage consistently with Pi 0.81.
- Existing extension, TUI, subagent scheduling, and rendering behavior remains unchanged apart from corrected accounting and provider dispatch.
- Both published package tarballs contain the expected source and documentation files.

## Out of scope

- Registering a new Tau-owned model provider.
- Adding llama.cpp or Qwen-specific Tau settings or UI.
- Supporting Pi 0.80 and Pi 0.81 through parallel runtime branches.
- Retrofitting standard usage into historical session files.
- Accounting for auto-name and other background extension model calls that are not tool executions or summary hooks; Pi 0.81 exposes no generic persisted usage channel for those calls.
- Changing Tau's public commands, settings, help text, extension README descriptions, or TUI design.
- Publishing a Tau release.

## References

- [Pi 0.81.0 release notes](https://pi.dev/news/releases/0.81.0)
- [Pi custom provider documentation](https://pi.dev/docs/latest/custom-provider)
- [Pi extension tool usage accounting](https://pi.dev/docs/latest/extensions#custom-tools)
- [Pi compaction and branch-summary usage](https://pi.dev/docs/latest/compaction)
- [Pi package peer dependency guidance](https://pi.dev/docs/latest/packages#dependencies)
- [Pi 0.81 usage accounting change](https://github.com/earendil-works/pi/pull/6671)
- [Pi 0.81 temporary compat entrypoint](https://github.com/earendil-works/pi/blob/v0.81.0/packages/ai/src/compat.ts)
