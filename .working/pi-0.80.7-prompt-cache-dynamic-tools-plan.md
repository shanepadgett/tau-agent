# Pi 0.80.7 Prompt Cache and Dynamic Tools Execution Plan

## Purpose

Make Tau's prompt and tool architecture work with Pi instead of reproducing unstable pieces of Pi around it. The finished package should:

- use Pi 0.80.7's cache-friendly dynamic tool activation;
- keep system-prompt content byte-stable whenever behavior has not changed;
- preserve Rok, project instructions, skills, tool guidance, and Tau extension behavior;
- keep the current local date available to the model without placing it in the system prompt;
- keep the root directory snapshot fixed for a session while moving it out of the system prompt;
- compose Tau-owned system-prompt additions once, in deterministic order, without mutating Pi's shared `systemPromptOptions` object;
- restore dynamic-tool state correctly on resume, reload, tree navigation, compaction, and child-agent creation;
- preserve CLI tool allowlists and deny-lists rather than silently re-enabling unavailable tools;
- retain safe fallback behavior on models that do not support deferred tool loading.

This plan is the implementation authority. A new agent should execute the phases in order and keep every phase green before moving on.

## Confirmed upstream behavior

The implementation relies on these Pi 0.80.7 contracts:

1. `pi.registerTool()` may run during extension loading or later.
2. `pi.getActiveTools()` returns active tool names.
3. `pi.getAllTools()` returns all registered definitions and `sourceInfo`.
4. `pi.setActiveTools()` replaces the complete active tool-name list.
5. Pi wraps extension tools and compares active tools before and after `execute()`.
6. A pure addition during `execute()` is recorded as `addedToolNames` on the tool result.
7. A change that removes any previously active tool during the same execution is not annotated as a cache-friendly addition.
8. Supported Anthropic and OpenAI Responses models place deferred definitions at the recorded tool-result position.
9. Unsupported models retain correct behavior by sending the normal active tool set.
10. `before_agent_start` handlers chain through `event.systemPrompt`.
11. A `before_agent_start` result may include a hidden custom message that is persisted and participates in model context.
12. `systemPromptOptions` is reused by the current Pi session implementation until Pi rebuilds its base prompt. Non-idempotent mutation can therefore accumulate across user prompts.

Primary references:

- <https://pi.dev/news/releases/0.80.7>
- <https://pi.dev/docs/latest/extensions#dynamic-tool-loading>
- <https://github.com/earendil-works/pi/blob/v0.80.7/packages/coding-agent/src/core/extensions/wrapper.ts>
- <https://github.com/earendil-works/pi/blob/v0.80.7/packages/ai/src/utils/deferred-tools.ts>
- <https://github.com/earendil-works/pi/blob/v0.80.7/packages/coding-agent/src/core/agent-session.ts>

## Scope decisions

These decisions are fixed for this work.

### Pi versions

- Upgrade the root development dependencies for `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` together from `0.80.6` to `0.80.7`.
- Regenerate `package-lock.json` through npm. Do not hand-edit lockfile dependency records.
- Leave `packages/agent/package.json` peer dependency ranges as `"*"`. The dynamic activation remains functionally correct on older Pi versions; only the cache optimization is absent.
- Do not bump Tau package versions. Versioning and publication are separate work.

### Prompt ownership

- Keep Soul as Tau's canonical system-prompt composer. A distributed Pi extension package has no package-level `SYSTEM.md` override mechanism, so `before_agent_start` remains the correct public hook for Tau's Rok replacement prompt.
- Stop Tau extensions from independently mutating `event.systemPromptOptions`.
- Introduce one internal prompt-contribution registry. Tau extensions register pure prompt contributions during extension factory execution. Soul collects them in stable order during its sole composing handler.
- When Soul is disabled, the composer starts with Pi's `event.systemPrompt` and appends enabled Tau contributions. This preserves current non-Soul extension behavior.
- When Soul is enabled, the composer starts with `buildRokPrompt(...)` and appends enabled Tau contributions.
- External extensions loaded after Soul still chain through Pi normally. External extensions loaded before Soul can only be preserved reliably through Pi resources represented in `systemPromptOptions`, such as custom prompts, append prompts, context files, skills, and tool metadata. Document this limitation in code comments; do not invent a public priority API.

### Runtime facts

- Keep project instructions and safety rules in the system prompt.
- Keep the current working directory in the system prompt, matching Pi's default behavior.
- Remove current date and root directory snapshot from the system prompt.
- Add those facts through a hidden, persisted `tau.runtime-context` custom message.
- Format the displayed date from local process time as `14 July 2026`. Do not use UTC conversion or include timezone text.
- Recalculate the date before each user-triggered agent run so a session crossing local midnight receives a new date message.
- Freeze the root snapshot at `session_start`. Recompute only when Pi starts or replaces/reloads the extension runtime.
- Detect matching runtime-context messages in compaction-aware active context. Reinject missing date or snapshot facts when compaction or tree navigation removes them from active model context.

### Dynamic tools

- Add one public extension tool named `load_tools`.
- Give it one required `capability` field using `StringEnum` for provider compatibility.
- Supported capabilities are exactly `web`, `image`, and `appshot`.
- Keep `subagent`, `context_sync`, and all core coding/exploration tools active.
- Keep `ask_question` under its existing `/qna` lifecycle.
- Register every specialist tool during normal extension loading. Never register specialist definitions lazily inside `load_tools`.
- Start normal full-tool Tau sessions with specialist groups inactive.
- Activate a group only by adding its names to the current active set inside `load_tools.execute()`.
- Never remove another tool from inside `load_tools.execute()`.
- Once loaded, a specialist group remains active for the current branch unless tree navigation moves before its load result.
- Reconstruct loaded groups from persisted `load_tools` results during `session_start` and `session_tree`.
- Do not add settings, unload commands, capability aliases, arbitrary tool-name loading, or automatic natural-language routing.

Capability membership:

```text
web
  webfetch
  websearch
  codesearch

image
  image_gen

appshot
  list_windows
  screenshot_window
  activate_app
```

### Dynamic tool prompt metadata

- `load_tools` remains in the stable textual tool list and carries the stable discovery guidance.
- Deferred specialist tools must not define `promptSnippet` or `promptGuidelines`.
- Move every critical specialist usage rule into its native tool `description` or parameter descriptions.
- This keeps Soul's system prompt byte-identical when specialist tools become active while still giving the model complete instructions in the newly loaded native definitions.

## Files expected to change

Dependency files:

- `package.json`
- `package-lock.json`

Prompt architecture:

- `packages/agent/shared/system-prompt-contributions.ts` (new)
- `packages/agent/extensions/soul/index.ts`
- `packages/agent/extensions/soul/prompt.ts`
- `packages/agent/extensions/silent-command-runner/index.ts`
- `packages/agent/extensions/subagent/index.ts`
- `packages/agent/extensions/context/index.ts`
- `packages/agent/extensions/turn-budget/index.ts`
- `.pi/extensions/tau-schema-sync/index.ts`

Dynamic tools:

- `packages/agent/extensions/tool-loader/index.ts` (new)
- `packages/agent/extensions/tool-loader/README.md` (new)
- `packages/agent/extensions/web/webfetch.ts`
- `packages/agent/extensions/web/websearch.ts`
- `packages/agent/extensions/web/codesearch.ts`
- `packages/agent/extensions/image-gen/index.ts`
- `packages/agent/extensions/appshot/index.ts`
- `packages/agent/extensions/tau-help/help.md`

Tests:

- `packages/agent/test/shared/system-prompt-contributions.test.ts` (new)
- `packages/agent/test/extensions/soul/index.test.ts` (new or existing file if one appears during implementation)
- `packages/agent/test/extensions/soul/prompt.test.ts`
- `packages/agent/test/extensions/silent-command-runner/index.test.ts` or the extension's existing test file
- `packages/agent/test/extensions/subagent/index.test.ts`
- `packages/agent/test/extensions/context/index.test.ts`
- `packages/agent/test/extensions/turn-budget/index.test.ts` or the extension's existing test file
- `packages/agent/test/extensions/tool-loader/index.test.ts` (new)
- `packages/agent/test/extensions/web/tools.test.ts`
- `packages/agent/test/extensions/image-gen/index.test.ts`
- `packages/agent/test/extensions/appshot/index.test.ts`

The implementing agent must grep for explicit tool lists, Soul runtime-context expectations, and extension catalogs after making the core changes. Update only stale references caused by this work.

## Phase 1: upgrade the Pi development baseline

### Changes

1. In root `package.json`, set all three Pi packages to `0.80.7`:

   ```json
   "@earendil-works/pi-ai": "0.80.7",
   "@earendil-works/pi-coding-agent": "0.80.7",
   "@earendil-works/pi-tui": "0.80.7"
   ```

2. Use npm to update the lockfile so direct and transitive Pi package records resolve consistently.
3. Inspect the resulting lockfile diff. Reject unrelated package upgrades.
4. Confirm installed 0.80.7 declarations expose the expected extension APIs and `addedToolNames` result/message fields.
5. Search the repository again for `sendSessionIdHeader`. It must remain absent.
6. Do not add `sessionAffinityFormat` to `packages/agent/extensions/xai/index.ts`. Tau's xAI provider never used the removed flag.
7. Do not set `supportsToolSearch` on the xAI model. Pi's safe fallback is required until the xAI endpoint explicitly supports the protocol.

### Acceptance

- Root manifest and lockfile use Pi 0.80.7 consistently.
- No unrelated dependency versions move.
- No repository-owned model compatibility migration is necessary.

## Phase 2: add deterministic Tau prompt contributions

### New internal module

Create `packages/agent/shared/system-prompt-contributions.ts`.

Define a small internal contract with these properties:

- stable string `id`;
- numeric `order`;
- a render callback receiving the current `BeforeAgentStartEvent` and `ExtensionContext`;
- callback return type `string | undefined | Promise<string | undefined>`;
- registration returns an unsubscribe function;
- registrations are stored by `id` with an opaque registration token;
- unsubscribe removes an entry only when its token still owns that `id`;
- collection sorts by `order`, then `id`;
- collection trims empty results;
- collection deduplicates exact repeated blocks while preserving the first occurrence;
- collection does not mutate the event, context, or `systemPromptOptions`;
- the module exposes no public Tau event or user setting.

Use names that make ownership clear, for example:

```ts
registerTauSystemPromptContribution(...)
collectTauSystemPromptContributions(...)
```

Do not add a class. A module-level map plus two functions is enough.

### Reload and replacement safety

Pi reloads extension factories. Module caching can outlive one extension instance. Prevent stale callbacks:

1. Each registration receives a unique token.
2. Re-registering the same `id` replaces the previous callback.
3. Each extension stores its unsubscribe function.
4. Each extension calls unsubscribe during `session_shutdown`.
5. Token comparison prevents an old instance from deleting a newer replacement registration.

### Convert Tau-owned contributors

Move only prompt text into registered callbacks. Keep unrelated lifecycle behavior in the owning extension.

Use stable order constants. Recommended order:

```text
100  selected-context authority guidance
200  silent command runner instructions
300  subagent catalog
400  turn-budget secrecy instruction
500  repository-local schema-sync instructions
```

#### Context

In `packages/agent/extensions/context/index.ts`:

- remove its direct `before_agent_start` prompt handler;
- register a contribution that returns the existing selected-context instruction only when `active.length > 0`;
- retain session restoration, commands, tools, and events unchanged;
- unregister on shutdown without interfering with other shutdown behavior.

#### Silent command runner

In `packages/agent/extensions/silent-command-runner/index.ts`:

- remove mutation of `event.systemPromptOptions.appendSystemPrompt`;
- remove the direct prompt append handler;
- register a contribution that calls `formatSilentCheckPrompt(settings.commands)` only while the extension is enabled and has commands;
- preserve command execution, mutation detection, error reporting, and settings reload behavior;
- unregister during shutdown.

#### Subagent

In `packages/agent/extensions/subagent/index.ts`:

- move agent discovery, warning emission, sorting, and prompt formatting into an async contribution;
- return no contribution while `subagent` is inactive;
- remove mutation of `appendSystemPrompt`;
- preserve the existing exact wording unless tests show a cache or correctness reason to alter it;
- preserve dynamic discovery on each user prompt so edited agent definitions take effect;
- unregister during shutdown alongside controller cleanup.

#### Turn budget

In `packages/agent/extensions/turn-budget/index.ts`:

- remove its direct `before_agent_start` handler;
- register the existing secrecy instruction while enabled;
- leave steering messages, markers, pruning, counters, and settings unchanged;
- unregister during shutdown.

#### Repository schema sync

In `.pi/extensions/tau-schema-sync/index.ts`:

- stop mutating `event.systemPromptOptions.promptGuidelines`;
- register `SETTINGS_PROMPT` through the internal contribution registry;
- remove its direct prompt handler;
- preserve schema generation and file hashing unchanged;
- unregister during shutdown.

This project extension already imports tracked package internals by relative path, so another tracked relative import is acceptable here. Do not expose the registry as a package public API.

### Soul composition

In `packages/agent/extensions/soul/index.ts`:

1. Keep loading `soul.enabled` during `session_start`.
2. Keep freezing session root context during `session_start`.
3. In `before_agent_start`, collect all registered Tau contributions exactly once.
4. When Soul is enabled:
   - build the Rok base from a fresh read-only view of `event.systemPromptOptions`;
   - append collected contributions in canonical order;
   - return the complete composed system prompt.
5. When Soul is disabled:
   - start from `event.systemPrompt` supplied by Pi;
   - append collected contributions in canonical order;
   - return `undefined` only when there are no contributions and no runtime message to add.
6. Never mutate `event.systemPromptOptions`.
7. Add one concise comment explaining why Soul must compose Tau-owned contributions centrally: Pi reuses base prompt options, and non-idempotent mutation accumulates.

Use one local append operation that adds `\n\n` only between non-empty blocks. Do not create a generic prompt framework.

### Prompt contribution tests

Add tests proving:

1. Contributions sort by `order`, then `id`.
2. Exact duplicate text is emitted once.
3. Empty and whitespace-only contributions are omitted.
4. Async contributions retain canonical order regardless of completion order.
5. Re-registering an `id` replaces its callback.
6. An old unsubscribe cannot remove a newer registration with the same `id`.
7. Repeated collection does not mutate or grow the input options.
8. Soul enabled composes each Tau block once on repeated user prompts.
9. Soul disabled preserves Pi's supplied `event.systemPrompt` and appends Tau blocks once.
10. A frozen `systemPromptOptions` object can pass through all converted handlers without error.
11. Subagent discovery text does not accumulate across repeated calls.
12. Silent command instructions do not accumulate across repeated calls.

## Phase 3: move runtime facts out of the system prompt

### Refactor the runtime context model

In `packages/agent/extensions/soul/prompt.ts`:

1. Remove `date` from `RuntimeContext`.
2. Keep normalized `cwd` and frozen `rootSnapshot`.
3. Change `freezeRuntimeContext(cwd)` so it never reads the date.
4. Remove `formatDate()` from system-prompt construction.
5. Replace `formatRuntimeContext()` with a CWD-only system-prompt block:

   ```text
   Current working directory: /normalized/path
   ```

6. Keep the CWD block in the same stable location at the end of the Rok system prompt.
7. Export narrowly scoped helpers needed by Soul index tests:
   - local date key formatting, such as `2026-07-14`;
   - local display formatting, such as `14 July 2026`;
   - runtime-context message content formatting;
   - snapshot fingerprinting if implemented in this file.

Avoid locale-dependent test output. Either implement month names from a fixed English array or inject the formatter/date into tests. The production result must be English `day month year` using local date fields.

### Runtime-context message type

Define a strict details type near Soul:

```ts
interface RuntimeContextMessageDetails {
  version: 1;
  dateKey: string;
  snapshotHash: string;
  includesSnapshot: boolean;
}
```

Use custom type:

```text
tau.runtime-context
```

The message must use `display: false`.

The model-visible content is:

```text
Current local date: 14 July 2026
Root directory snapshot (depth 2):
- path
- directory/
```

If the current snapshot is empty, omit the root-snapshot heading and paths. The details still record `includesSnapshot: true` so Soul does not repeatedly inject an empty snapshot.

### Snapshot fingerprint

Compute a deterministic fingerprint from:

- a format version;
- normalized CWD;
- root snapshot paths in their existing deterministic order.

Use SHA-256 from `node:crypto`. Hashing avoids persisting a second full copy of the snapshot in message details.

### Compaction-aware detection

Before returning a runtime-context message:

1. Compute the current local `dateKey` and display date.
2. Compute the frozen snapshot hash.
3. Inspect `ctx.sessionManager.buildContextEntries()` rather than the full branch alone.
4. Narrow entries defensively to hidden `tau.runtime-context` custom messages with valid versioned details.
5. Determine separately whether active model context already contains:
   - the current date;
   - the current snapshot.
6. Return no runtime message when both are present.
7. If only the date is missing, inject a date-only message with `includesSnapshot: false`.
8. If the snapshot is missing, inject the date and snapshot with `includesSnapshot: true`.

This behavior handles:

- first prompt in a new session;
- repeated prompts on the same date;
- sessions crossing local midnight;
- resume on a later date;
- tree navigation to a branch before the context message;
- compaction that removes the previous runtime message from active context;
- `/reload` with a changed root snapshot.

Do not send the message from `session_start`. Opening or reloading a session should not mutate its history until the next agent run.

### Runtime-context tests

Add tests proving:

1. `buildRokPrompt` contains CWD but no current date and no root snapshot.
2. Local date formatting produces `14 July 2026` from a local `Date` fixture.
3. Date-key formatting uses local getters, not `toISOString()`.
4. First prompt injects one hidden message containing date and snapshot.
5. A second prompt with matching active-context details injects nothing.
6. A new local date injects a date-only message.
7. A changed snapshot hash injects date plus snapshot.
8. A matching message outside compaction-aware active context does not suppress reinjection.
9. Tree navigation to a branch without the message causes reinjection on the next prompt.
10. Root snapshot remains unchanged after filesystem changes during the same runtime.
11. A new `session_start` recomputes the snapshot.
12. `.git`, ignored `node_modules`, sorting, and the 300-path cap retain existing behavior.

## Phase 4: add cache-friendly `load_tools`

### Extension files

Create:

- `packages/agent/extensions/tool-loader/index.ts`
- `packages/agent/extensions/tool-loader/README.md`

The extension is auto-discovered by the existing package manifest glob. Do not modify package manifests to list it manually.

### Tool schema

Use `defineTool`, TypeBox, and `StringEnum`.

Required input:

```ts
{
  capability: "web" | "image" | "appshot";
}
```

No optional fields. No arrays. No arbitrary names.

Suggested metadata:

```text
name: load_tools
label: Load Tools
description: Load one Tau specialist tool group for the current session. Groups: web for public web and implementation research; image for raster generation and editing; appshot for macOS window discovery, capture, and activation.
promptSnippet: Load a specialist Tau tool group when the task needs web research, image generation, or macOS app inspection
```

One stable guideline is acceptable because `load_tools` is permanently active in normal sessions:

```text
Use load_tools before attempting a specialist capability whose tools are not currently available.
```

### Strict result details

Use required state:

```ts
interface LoadToolsDetails {
  version: 1;
  capability: "web" | "image" | "appshot";
  requestedToolNames: string[];
  addedToolNames: string[];
}
```

The extension result's own `addedToolNames` field must not be set manually. `addedToolNames` inside `details` is Tau state for restoration and rendering/testing. Pi owns the top-level cache annotation.

### Normal-session management detection

Do not override explicit constrained tool configurations.

At `session_start`, before hiding anything:

1. Read the active set.
2. Enter managed dynamic-loading mode only when:
   - `load_tools` is active; and
   - every specialist tool in all three groups is initially active.
3. If any specialist tool is absent, treat the session as explicitly constrained and do not automatically hide or restore specialist groups.

This rule preserves common `--tools` and `--exclude-tools` intent without requiring unsupported access to Pi's raw CLI allowlist.

In unmanaged mode, `load_tools` may still request a group. Pi will activate only registered, allowed tools. The result must report the actual delta.

### Initial hiding and restoration

In managed mode during `session_start`:

1. Scan the active branch for valid persisted `load_tools` tool results.
2. Reconstruct capabilities in transcript order.
3. Start from the current active set.
4. Remove every specialist name.
5. Add names for capabilities loaded on the active branch.
6. Preserve all unrelated tools exactly, including the current bash toggle and transient package tools.
7. Pass names to `pi.setActiveTools()` in canonical order.

Canonical ordering must be deterministic:

1. preserve existing unrelated-tool order;
2. append restored groups in capability order `web`, `image`, `appshot`;
3. use the member order declared in this plan.

Unknown or unavailable names are ignored by Pi. The extension should still validate its own static group table against `pi.getAllTools()` and report a clear load result when no requested tool can be activated.

### Execution behavior

Inside `load_tools.execute()`:

1. Read `pi.getActiveTools()` immediately before mutation.
2. Resolve the requested fixed group.
3. Filter requested names to names present in `pi.getAllTools()`.
4. Build the next list by preserving the complete current list and appending missing requested names in canonical group order.
5. Call `pi.setActiveTools(next)` synchronously before any awaited operation.
6. Read `pi.getActiveTools()` again.
7. Compute the actual added names from before and after.
8. Return concise content:

   ```text
   Loaded web tools: webfetch, websearch, codesearch.
   ```

   For an already active group:

   ```text
   Web tools are already loaded: webfetch, websearch, codesearch.
   ```

   For unavailable tools, return a clear failure description and mark the result as an error through a `tool_result` handler or by throwing when the entire group is unavailable. Prefer throwing for complete unavailability because Pi documents thrown execution errors as the supported error mechanism.

9. Return strict details containing requested and actual added names.

The before/after change must be a pure addition. Never combine group activation with cleanup, qna deactivation, bash changes, or branch restoration.

### Tree navigation

In managed mode, handle `session_tree`:

1. Rescan the new active branch.
2. Remove all specialist names from the current active set.
3. Re-add only groups loaded on the selected branch.
4. Preserve unrelated active tools and order.

Removal during tree navigation is acceptable. Branch navigation already changes conversation history and may invalidate provider caches. Correct branch state wins.

No special `session_compact` handler is needed. Keep loaded tools active in runtime. If compaction removes the historical load point, Pi safely sends those active definitions normally.

### Subagent compatibility

Do not alter `packages/agent/extensions/subagent/run.ts` unless a failing regression test proves a correction is required.

The intended behavior is:

- specialist definitions are registered upfront, so `pi.getAllTools()` retains stable `sourceInfo.path`;
- `extensionPathsForTools()` can find each owning extension while the tool is inactive in the parent;
- child sessions load only owner extension paths;
- the tool-loader extension is absent from children unless a child definition explicitly requests `load_tools`;
- specialist owner extensions do not deactivate themselves, so child exact active-tool validation continues to pass.

### Dynamic loader tests

Add focused tests for:

1. registration metadata and strict schema;
2. normal full-tool session hides all specialist groups and keeps core tools plus `load_tools`;
3. constrained session with one missing specialist does not auto-hide the remaining specialist tools;
4. `execute()` preserves unrelated active tools and appends one group in canonical order;
5. `execute()` never re-enables an unavailable or excluded tool;
6. repeated loading is idempotent;
7. parallel calls for different groups do not lose either group;
8. persisted result details restore groups on `session_start`;
9. malformed or unknown persisted details are ignored;
10. `session_tree` removes groups loaded only on the abandoned branch;
11. `session_tree` restores groups present on the selected branch;
12. Pi 0.80.7's actual extension wrapper attaches top-level `addedToolNames` for a pure addition;
13. no top-level `addedToolNames` is manually returned by Tau;
14. `extensionPathsForTools()` finds inactive specialist owners;
15. child session startup still satisfies exact requested active tools;
16. an unsupported provider path remains functionally correct without asserting cache-specific serialization owned by Pi.

Use an actual Pi session integration test for item 12 if existing test helpers can supply a fake model stream. Do not reproduce Pi's wrapper logic in a Tau mock and call that proof.

## Phase 5: make specialist definitions self-contained and cache-stable

### Web tools

Inspect:

- `packages/agent/extensions/web/webfetch.ts`
- `packages/agent/extensions/web/websearch.ts`
- `packages/agent/extensions/web/codesearch.ts`

For each definition:

1. remove `promptSnippet`;
2. remove `promptGuidelines`;
3. preserve every operational rule by folding it into the description or parameter descriptions;
4. keep schemas, output limits, execution, rendering, and error behavior unchanged;
5. keep wording stable and independent of current date, cwd, auth state, or platform.

Do not put the current date in `websearch`'s description. The hidden runtime-context message supplies it while keeping definitions byte-stable.

### Image generation

In `packages/agent/extensions/image-gen/index.ts`:

1. remove `promptSnippet` and `promptGuidelines`;
2. expand the native description enough to preserve these rules:
   - use for requested raster generation or AI editing;
   - omit `referenced_image_paths` for generation;
   - pass one to three local paths for editing/composition;
   - omit `path` for Tau external storage;
   - pass `path` only for an explicitly requested repository or destination file;
3. keep auth, file safety, no-overwrite behavior, mutation queue, and rendering unchanged.

### Appshot

In `packages/agent/extensions/appshot/index.ts`:

1. remove specialist `promptSnippet` and `promptGuidelines`;
2. preserve sequencing directly in descriptions:
   - `list_windows` discovers IDs and PIDs;
   - `screenshot_window` requires an exact ID from `list_windows` and a PNG path;
   - `activate_app` requires a listed PID and changes user focus, so use only when foregrounding is required;
3. preserve platform checks, permission guidance, file limits, PNG validation, and rendering.

### Prompt stability test

Add a test around `buildRokPrompt` with two active-tool configurations:

```text
before: core tools + load_tools
after:  core tools + load_tools + webfetch + websearch + codesearch
```

Supply no specialist snippets or guidelines. Assert the generated system prompt strings are exactly equal.

Repeat for `image` and `appshot`.

Also assert every specialist definition still has a non-empty description containing its critical usage constraints.

## Phase 6: documentation

### New extension README

Create `packages/agent/extensions/tool-loader/README.md` with product-level content only:

- what it is: Tau progressively exposes specialist tools;
- why it exists: most coding turns do not need web, image, or macOS app schemas, and Pi can load them later without discarding supported provider cache prefixes;
- how users invoke it: normally the agent calls `load_tools`; users may explicitly ask Tau to load web, image, or appshot tools;
- supported groups and their user-facing purpose;
- supported models optimize caching while other models retain correct behavior;
- `/reload` is required after changing extension code during development.

Do not describe wrapper internals, `addedToolNames`, source paths, or restoration data in the README.

### Tau help

Update `packages/agent/extensions/tau-help/help.md`:

- add a concise `tool-loader` section in the extension catalog;
- mention the `load_tools` tool and the three fixed groups;
- explain that Tau normally loads groups itself;
- do not promise cache preservation on every provider.

### Soul README

Update `packages/agent/extensions/soul/README.md` only where user-facing behavior changes:

- state that Soul supplies the current local date and initial root snapshot as hidden session context;
- avoid implementation details about custom message entries or fingerprints;
- preserve existing configuration instructions.

### Other references

Search README and help files for:

- exhaustive active tool lists;
- claims that all Tau tools are always available;
- current date described as system-prompt content;
- root snapshot described as system-prompt content.

Update only stale statements. Do not add a new architecture document unless the existing product docs cannot explain the behavior accurately.

## Phase 7: validation

### Focused automated tests

Run focused Vitest files while developing. At minimum cover:

```text
packages/agent/test/shared/system-prompt-contributions.test.ts
packages/agent/test/extensions/soul/
packages/agent/test/extensions/silent-command-runner/
packages/agent/test/extensions/subagent/
packages/agent/test/extensions/context/
packages/agent/test/extensions/turn-budget/
packages/agent/test/extensions/tool-loader/
packages/agent/test/extensions/web/
packages/agent/test/extensions/image-gen/
packages/agent/test/extensions/appshot/
```

Do not run the repository's prohibited aggregate automatic commands manually. Finish the turn and allow the configured automatic checks to run.

### Prompt invariants

Tests or a narrow diagnostic script must prove:

1. Two unchanged user prompts produce byte-identical system prompts.
2. Subagent and silent-command text appears once on every prompt.
3. Date and root snapshot do not appear in the system prompt.
4. CWD remains present in the system prompt.
5. The first active context contains one current local date and one root snapshot.
6. Dynamic specialist activation does not change the system prompt.
7. Dynamic activation changes only the active native tool list and transcript load metadata.
8. Tool ordering is deterministic after activation, resume, reload, and tree navigation.

### Interactive smoke tests

Extension changes require `/reload` before testing.

Use a supported model and perform:

1. Start a fresh session.
2. Confirm initial tools contain core tools and `load_tools`, with specialist groups absent.
3. Ask for current public information.
4. Confirm the agent calls `load_tools` with `web`, then uses a web tool.
5. Ask a second unrelated coding question and confirm web tools remain active.
6. Resume the session and confirm web tools restore.
7. Navigate to a branch before the loader result and confirm web tools become inactive.
8. Navigate back after the loader result and confirm they restore.
9. Ask for image generation and confirm `image_gen` appears only after loading `image`.
10. On macOS, ask for visual inspection and confirm appshot tools load and retain their required sequence.
11. Toggle bash off, load a specialist group, and confirm bash stays off.
12. Trigger `/qna`, load a specialist group if the flow permits, and confirm loader changes do not disturb qna lifecycle.

Repeat core correctness on one unsupported fallback model. It must still load and execute tools even if cache statistics do not improve.

### Cache observation

Use Pi's existing footer cache statistics. Do not add Tau telemetry.

For a supported provider:

1. Start a fresh session with specialist groups hidden.
2. Send a coding-only request and note cache write/read behavior.
3. Send another coding request and confirm the stable prefix is reused.
4. Load `web` through `load_tools`.
5. Confirm later requests retain cache reuse for the earlier prefix.
6. Repeat on a new same-project session to observe the effect of moving date and root snapshot out of the system prompt.

Cache hit numbers vary by provider and retention window. Acceptance is stable serialized structure and correct Pi metadata, not a fixed percentage.

## Failure handling and rollback boundaries

Keep each phase independently reversible.

### Prompt composition failure

Symptoms:

- missing Tau instruction blocks;
- repeated blocks after multiple user prompts;
- Soul-disabled mode loses extension instructions;
- stale extension callbacks after `/reload`.

Response:

- stop before dynamic-tool work;
- fix registry ownership, order, and shutdown tests;
- do not restore direct `systemPromptOptions` mutation.

### Runtime-context failure

Symptoms:

- date missing after compaction;
- duplicate date every turn;
- stale date after midnight;
- root snapshot changes during ordinary file edits;
- opening a session mutates history before a prompt.

Response:

- inspect compaction-aware context detection and details narrowing;
- keep date/root out of system prompt;
- do not switch to per-provider-call transient context injection.

### Dynamic loader failure

Symptoms:

- specialist tools unavailable after loader success;
- unrelated tools disappear;
- bash is re-enabled;
- resume loses loaded groups;
- child agents report active tool mismatch;
- top-level `addedToolNames` is absent on a supported integration test.

Response:

- verify pure-addition execution first;
- compare actual before/after active lists;
- verify specialist tools remain registered in `getAllTools()`;
- verify parent hiding is centralized in tool-loader rather than owner extensions;
- verify restoration occurs outside loader execution;
- do not manually forge top-level `addedToolNames`.

### Provider-specific cache failure

If correctness passes but cache behavior does not improve:

1. confirm the selected model advertises deferred-tool support;
2. compare system prompt bytes before and after activation;
3. compare tool ordering;
4. check that specialist definitions lack prompt snippets and guidelines;
5. inspect the persisted loader tool result for Pi's top-level `addedToolNames`;
6. confirm no provider payload hook strips or rewrites deferred-tool fields;
7. leave unsupported providers on fallback behavior.

Do not set compatibility capability flags merely to make a test pass.

## Final acceptance checklist

- [ ] Pi development dependencies and lockfile use 0.80.7.
- [ ] No `sendSessionIdHeader` migration is needed in repository code.
- [ ] xAI remains on safe dynamic-tool fallback.
- [ ] Soul centrally composes every Tau-owned prompt contribution.
- [ ] No Tau handler mutates `systemPromptOptions`.
- [ ] Repeated prompts do not grow the system prompt.
- [ ] Soul-disabled behavior preserves Pi's prompt plus Tau contributions.
- [ ] Date is absent from the system prompt.
- [ ] Root snapshot is absent from the system prompt.
- [ ] CWD remains in the system prompt.
- [ ] Current local date appears as `day month year` in hidden model context.
- [ ] Date updates after local midnight.
- [ ] Root snapshot remains frozen during a runtime and refreshes on runtime restart/reload.
- [ ] Runtime context survives resume, tree navigation, and compaction correctly.
- [ ] `load_tools` exposes exactly `web`, `image`, and `appshot`.
- [ ] Core coding tools, `subagent`, and `context_sync` remain initially active.
- [ ] Specialist tools register upfront and start inactive in normal full-tool sessions.
- [ ] Constrained CLI tool selections are not silently rewritten by initial hiding.
- [ ] Loader execution performs pure additions only.
- [ ] Pi records top-level `addedToolNames` automatically.
- [ ] Dynamic state restores from the active branch.
- [ ] Tree navigation removes and restores specialist groups according to branch history.
- [ ] Specialist tool descriptions contain all critical usage rules.
- [ ] Specialist tools have no prompt snippets or prompt guidelines.
- [ ] System prompt remains byte-identical after specialist activation.
- [ ] Parent dynamic hiding does not break child-agent exact tool selection.
- [ ] Supported providers preserve deferred-load cache structure.
- [ ] Unsupported providers remain correct.
- [ ] New extension README exists.
- [ ] Tau help reflects the new tool.
- [ ] Soul README reflects hidden runtime context.
- [ ] No unrelated settings, APIs, commands, telemetry, or provider flags were added.

## Implementation stopping point

After all acceptance items pass, stop. Do not add automatic intent classification, tool unloading, per-provider settings, cache dashboards, arbitrary tool groups, or public prompt-contribution APIs. Those require separate product decisions and evidence from this first implementation.
