# Pi 0.80.8 Alignment Plan

Current Tau monorepo deps: `@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui` at **0.80.7**.

Target: **0.80.8** (2026-07-16).

Source: <https://pi.dev/changelog> and <https://pi.dev/news/releases/0.80.8>, checked against local Tau code and the published 0.80.8 package types.

## Goal

Upgrade Tau to Pi 0.80.8 with the smallest correct changes. Prefer wiring existing APIs over inventing Tau-side replacements.

## Out of scope

- User-facing settings Tau does not own (`showCacheMissNotices`, `outputPad`, `externalEditor`, live `/model` catalog UX, `pi update --models`, project-local `pi config -l`)
- New Tau features unless they fall out of a required break
- Backward compatibility with pre-0.80.8 Pi APIs

## Findings

### Hard break in Tau code

`createAgentSession()` no longer accepts `authStorage` or `modelRegistry`. It takes async `modelRuntime?: ModelRuntime`.

Extension-facing surface still exposes `ctx.modelRegistry` as a sync compatibility facade. These still work:

- `find()`
- `getAll()` / `getAvailable()`
- `getApiKeyAndHeaders()`
- `getApiKeyForProvider()`

Facade change: `ModelRegistry.refresh()` is now `Promise<void>`. Tau does not call it today.

Only Tau call site that passes the removed option:

- `packages/agent/extensions/subagent/run.ts` → `createAgentSession({ modelRegistry: ctx.modelRegistry, ... })`

### Soft product conflict

Pi 0.80.8 ships built-in xAI device-code OAuth and Grok 4.5 Responses under provider id `xai`.

Tau ships a separate provider:

- id: `xai-oauth`
- browser OAuth + optional Grok CLI credential reuse
- used by model-fallback / context preferred models
- used by `image_gen` via `getApiKeyForProvider("xai-oauth")`

Built-in `/login xai` does not feed Tau `image_gen`.

### Already aligned

- `tool-loader` uses additive `pi.setActiveTools(...)` — matches Pi 0.80.7 cache-friendly dynamic tool loading
- model-fallback uses `completeSimple` from `@earendil-works/pi-ai/compat`
- no Tau imports of removed `AuthStorage` exports
- no `sendSessionIdHeader` usage (broken in 0.80.7 models.json)
- subagent already understands `xhigh` / `max` thinking levels

### Better lifecycle hook available since 0.80.4

`agent_end` = one low-level agent run finished; Pi may still auto-retry, compact+retry, or run follow-ups.

`agent_settled` = no automatic continuation left.

Tau currently treats `agent_end` as "done" in several places that probably want settled semantics.

## Work plan

### Phase 0 — Decision gate

Decide xAI strategy before coding Phase 3.

Options:

1. **Keep dual providers for now**
   - cheapest
   - two xAI logins in UI
   - document which login powers chat vs `image_gen`

2. **Migrate Tau to built-in `xai`**
   - preferred models / image_gen use `xai`
   - delete or gut `packages/agent/extensions/xai`
   - only do this after verifying built-in OAuth token works for Grok Imagine API used by `image_gen`

3. **Hybrid**
   - drop Tau chat provider registration
   - keep only Imagine-auth path if built-in chat auth cannot serve image generation

Default if no decision: option 1 for the upgrade PR, open follow-up for option 2/3.

### Phase 1 — Dependency bump

Files:

- root `package.json`
- lockfile via npm install

Actions:

1. Bump root devDependencies:
   - `@earendil-works/pi-ai` → `0.80.8`
   - `@earendil-works/pi-coding-agent` → `0.80.8`
   - `@earendil-works/pi-tui` → `0.80.8`
2. Install and resolve lockfile.
3. Confirm workspace peers still `*` on agent/tui packages.
4. Run automatic checks after TS edits; fix only real breakages.

Success:

- packages resolve at 0.80.8
- typecheck starts from current Tau sources against new types

### Phase 2 — Subagent SDK fix (required)

Files:

- `packages/agent/extensions/subagent/run.ts`
- related tests under `packages/agent/test/extensions/subagent/`

Actions:

1. Remove `modelRegistry: ctx.modelRegistry` from `createAgentSession(...)`.
2. Do **not** invent a Tau wrapper around `ModelRuntime` unless the default path fails.
3. Keep preflight auth checks on `ctx.modelRegistry.getApiKeyAndHeaders(...)` and model lookup on `ctx.modelRegistry.find(...)`.
4. Rely on default `ModelRuntime` created by `createAgentSession` from `agentDir` auth/models paths.
5. Child extensions still load through existing `DefaultResourceLoader` + `additionalExtensionPaths`, so registered providers reappear on the child runtime.
6. Update tests/mocks if they assert the old option bag.

Why default runtime is enough:

- child already receives a resolved `model` object
- disk-backed auth is shared through agent dir
- child resource loader re-registers the extension providers the child needs

If later we need shared in-memory runtime overrides (`setRuntimeApiKey`), ExtensionContext still does not expose `modelRuntime`. That is a separate Pi/Tau design problem; do not fake it in this plan.

Success:

- subagent sessions create on 0.80.8
- auth failure still fails early with current warning/error paths
- no references to removed `CreateAgentSessionOptions.modelRegistry`

### Phase 3 — xAI alignment (decision-dependent)

Files likely involved:

- `packages/agent/extensions/xai/**`
- `packages/agent/extensions/image-gen/**`
- `packages/agent/extensions/context/sync.ts` preferred model list
- `packages/agent/extensions/tau-help/help.md`
- `packages/agent/extensions/xai/README.md`
- related tests

#### If option 1 (keep dual)

1. Leave provider id `xai-oauth`.
2. Update user-facing copy so Tau login is distinct from built-in `/login xai`.
3. Keep image_gen on `xai-oauth`.
4. Note in help that built-in xAI login does not enable Tau image generation.

#### If option 2 (migrate to built-in)

1. Verify built-in `xai` credential can authorize:
   - Grok chat / Responses path already used by Pi
   - Grok Imagine endpoints used by Tau `image_gen`
2. Point preferred models at provider `xai` / built-in model ids.
3. Point `image_gen` token lookup at `xai`.
4. Remove Tau `registerProvider("xai-oauth", ...)` and OAuth implementation if no longer needed.
5. Clean dead files, help, README, tests in the same change.
6. Update help.md in that same change per Tau help rule.

#### If option 3 (hybrid)

1. Keep only the minimal auth path image generation needs.
2. Stop advertising Tau as the chat Grok provider.
3. Prefer built-in xAI for model selection.

Success:

- one clear story for how a user logs in for Grok chat
- one clear story for how `image_gen` gets a token
- no silent dual-login traps left undocumented

### Phase 4 — Settled lifecycle cleanup

Move "user-facing run is finished" behavior from `agent_end` to `agent_settled` where early fire is wrong.

| Extension | Current | Target | Notes |
| --- | --- | --- | --- |
| `attention` | notify on `agent_end` | `agent_settled` | avoids notify before retry/follow-up |
| `silent-command-runner` | run checks on `agent_end` | `agent_settled` | checks should see final tree |
| `run-summary` | wall/cost on `agent_end` | `agent_settled` | summary should mean full turn, not partial run |
| `footer` | state refresh on `agent_end` | keep `agent_end` **and** add `agent_settled` if idle UI lags | only if needed after testing |
| `qna` | `agent_end` | leave | mid-run UI cleanup, not "done" |
| `context` | `agent_end` | leave unless proven wrong | inspect before moving |

Also available, not required now:

- `session_before_compact` / `session_compact` now include `reason` and `willRetry`
- Tau `explore` only clears cache on compact; no change required unless we later branch on reason

Success:

- attention / silent runner / run-summary no longer fire in the middle of auto-retry or follow-up chains
- tests updated to emit `agent_settled` where they previously only simulated `agent_end`

### Phase 5 — Dynamic tools pass (verify only)

File:

- `packages/agent/extensions/tool-loader/index.ts`

Checks:

1. Loader remains additive: never remove currently active tools in the same `setActiveTools` call.
2. Specialist tools preferably put usage detail in tool `description`, not active-only `promptGuidelines`, if prompt-cache misses show up after activation.
3. No custom cache protocol needed; Pi records additive tool activation on the tool result.

Success:

- no code change, or only a small guideline/description cleanup if cache miss noise appears

### Phase 6 — Cleanup and docs touchups

Only for surfaces changed above:

1. `packages/agent/extensions/tau-help/help.md` if xAI/image-gen invocation story changes
2. extension README(s) only when user-facing behavior changes
3. delete dead xAI files if Phase 3 removes the extension
4. no manual edits to `packages/agent/schemas/tau.schema.json`

## Implementation order

1. Phase 0 decision (xAI)
2. Phase 1 dep bump
3. Phase 2 subagent fix
4. Phase 4 settled hooks
5. Phase 3 xAI work if not deferred
6. Phase 5 verify tool-loader
7. Phase 6 docs/cleanup

If shipping one PR: do Phase 1 + 2 + 4, leave Phase 3 as option 1 copy-only or defer.

If shipping two PRs:

- PR A: bump + subagent + settled hooks
- PR B: xAI migration or explicit dual-login docs

## Test plan

Automated:

- existing unit tests for subagent, image-gen, xai, run-summary, attention, silent-command-runner, model-fallback
- monorepo automatic `ts-check` after TS changes
- monorepo automatic `md-check` after markdown changes

Manual after `/reload`:

1. Start session on 0.80.8
2. Run a subagent task with parent model
3. Run a subagent task with explicit `provider/model`
4. Force a model auth failure path and confirm warning/error text still makes sense
5. Confirm attention / run-summary fire once after a turn that includes tool use
6. Load specialist tools via `load_tools`, then call one tool from the loaded group
7. xAI path per chosen Phase 3 option:
   - option 1: Tau `xai-oauth` login still works for chat preference + image_gen
   - option 2/3: built-in `/login xai` covers the intended surfaces

## Risks

- Default child `ModelRuntime` does not share parent in-memory runtime API key overrides. Accept unless we hit that path.
- Built-in xAI auth may not authorize Imagine endpoints. Do not delete Tau OAuth before proving it.
- Moving run-summary to `agent_settled` changes when the entry appears; tests and user expectation both need the later event.
- Dual xAI providers will confuse users if left unlabeled.

## Non-goals revisited

Do not:

- reimplement `ModelRuntime` inside Tau
- switch model-fallback off `ctx.modelRegistry` just to chase new names
- add settings, commands, or UI for catalog refresh
- keep dead xAI code "for later" without an explicit follow-up

## Done when

- Tau builds and tests against Pi 0.80.8
- subagent no longer passes removed SDK options
- finished-run extensions use settled semantics where required
- xAI login story is either intentionally dual and documented, or migrated cleanly to built-in `xai`
- no obsolete files/docs left from removed paths
