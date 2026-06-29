# Search Extension Blast Radius

Preliminary investigation for `src/extensions/search/`.

## Entry Point

- Loaded by Pi from `package.json` via `./src/extensions/*/index.ts`.
- No direct imports of `searchExtension` elsewhere.

## Public Tool Surface

`src/extensions/search/index.ts` registers these tools:

- `read` wraps Pi built-in `createReadToolDefinition` and adds search evidence metadata.
- `grep` provides compact batched `rg` content search.
- `find` provides compact batched path discovery over `rg --files`.
- `ls` provides compact directory inventory and startup workspace map.
- `forget` marks prior search evidence forgotten or irrelevant when working memory is enabled.

Tool names, params, output, prompt snippets, and prompt guidelines are public behavior for the agent.

## Pi Lifecycle Hooks

`src/extensions/search/index.ts` hooks:

- `session_start`: loads `extensions.search` settings, toggles `forget`, computes existing render statuses.
- `before_agent_start`: injects startup workspace map and working-memory guidance into the system prompt.
- `context`: prunes model-bound context when `workingMemory` is enabled.
- `session_shutdown`: unsubscribes Tau event handlers.

## Tau Event Integrations

Shared event bus definitions live in `src/shared/events.ts`.

Search consumes:

- `tau:file-mutation.applied`
  - Emitted by `src/extensions/patch/index.ts` after `patch` tool results.
  - Search sends auto-read or path-update custom messages after successful patch mutations.
- `tau:context.snapshot`
  - Emitted by `.pi/extensions/tau-edit/index.ts`.
  - `/tau-edit` selected files become search auto-read snapshots.

## Custom Messages

Search emits and renders:

- `tau.search.auto-read`
- `tau.search.path-update`

Message details use two metadata shapes:

- `searchEvidence`: generic evidence contract used by pruning and render status.
- `searchMemory`: typed memory-action details for auto-read, path-update, and forget.

Changing these shapes affects context pruning, UI status badges, tests, patch integration, and `/tau-edit` snapshots.

## Internal Modules

- `context-pruning.ts`: replaces stale/forgotten/irrelevant evidence in outbound model context.
- `evidence.ts`: `searchEvidence` contract and parser.
- `find.ts`: `find` tool.
- `forget.ts`: `forget` tool and parser.
- `grep.ts`: `grep` tool and compact formatter.
- `ls.ts`: `ls` tool and startup workspace map.
- `memory-messages.ts`: auto-read/path-update builders and parsers.
- `mutation-memory.ts`: patch/tau-edit event handling and auto-read eligibility.
- `path-utils.ts`: path normalization, glob matching, noise/hidden/ignored checks.
- `read.ts`: built-in read wrapper with evidence metadata.
- `render-state.ts`: outdated/forgotten/irrelevant render status state.
- `ripgrep.ts`: `rg` subprocess wrapper.
- `settings.ts`: `extensions.search` settings spec.

## Shared Components Touched

- `src/shared/events.ts`: event bus used for patch and tau-edit integration.
- `src/shared/settings/*`: loads and discovers Tau settings specs.
- `scripts/generate-tau-schema.ts`: includes search settings in generated schema.

## Settings Surface

Defined in `src/extensions/search/settings.ts`:

- `workingMemory`: enables pruning and `forget`.
- `excludedPaths`: excludes paths/globs from automatic mutation auto-reads.

Changing settings requires schema regeneration through the existing schema workflow; do not edit `schemas/tau.schema.json` manually.

## Tests

Existing coverage:

- `test/extensions/search/search.behavior.test.ts`

Covered behavior:

- Auto-read makes older navigation evidence outdated.
- Path-update makes older current evidence outdated.
- `forget` marks evidence irrelevant.
- Mutation memory sends auto-read messages after patch.
- Excluded/noise/large files are skipped with reasons.

## Similar Names Outside This Extension

These are unrelated UI filtering widgets, not search working memory:

- `src/shared/tui/search-list.ts`
- `src/extensions/commit/ui/commit-file-picker.ts`
- `src/extensions/ideas/browser.ts`
- `src/extensions/stash/browser.ts`

## High-Risk Change Areas

- Tool names, parameter schemas, result formats, and prompt guidelines.
- `searchEvidence` and `searchMemory` metadata contracts.
- Context pruning rules in `context-pruning.ts`.
- Auto-read eligibility in `mutation-memory.ts`.
- Event names and payloads shared with `patch` and `.pi/extensions/tau-edit`.
- Startup workspace-map injection into `before_agent_start`.
