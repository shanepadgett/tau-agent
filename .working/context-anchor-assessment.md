# Lazy context anchors: repository assessment

Date: 2026-07-16

## Recommendation

Add a second file class named `anchors` to context entries and test it on two broad entries before migrating the full catalog.

- `files` remain eager, authoritative autoreads.
- `anchors` contribute context membership but inject only their paths.
- The agent inspects anchors with `grep` or ranged `read` calls when the task requires them.
- Loading policy stays curated. `context_sync` preserves existing classifications and defaults new membership to eager.

The repository has enough broad entries to make this useful. Several current selections load tens of thousands of tokens before work starts. The existing Explore tools already support the lazy workflow, so this does not need another filesystem tool.

## What the repository looks like now

The `.pi/contexts` catalog currently contains:

- 40 TOML concepts
- 7 selector tabs
- 121 selectable entries
- About 59 KB of catalog TOML
- 28 extension concepts and 87 extension entries

Every entry currently has one file class:

```toml
[entry]
description = "..."
files = ["..."]
```

`files` means both membership and immediate full-file loading. In `packages/agent/extensions/context/index.ts`, selecting entries deduplicates their paths and emits every path through `tau:autoread.requested`. Explore's autoread implementation then reads each file in full and emits a visible message for it.

Representative broad entries:

| Entry | Paths | Approximate eager payload |
| --- | ---: | ---: |
| `extensions/context/all` | 21 | 107 KB, about 27k tokens |
| `extensions/explore/all` | 21 | 111 KB, about 28k tokens |
| `extensions/patch/all` | 86 | About 60 KB, roughly 15k tokens, plus 86 message wrappers |
| `extensions/patch/tests` | 85 | Similar high message count |
| `core/settings/all` | 20 | About 26 KB, roughly 6.5k tokens |
| `tui/shared-components/all` | 15 | About 35 KB, roughly 9k tokens |

Selecting `extensions/context/all`, `extensions/explore/all`, and `extensions/patch/all` together can consume roughly 70k model tokens before the task begins.

The catalog has two common shapes:

1. Narrow entries such as `extensions/explore/grep` and `extensions/context/maintenance`. Their files are tightly coupled to the selected task.
2. Broad `all` entries containing runtime code, tests, docs, integrations, generated output, and fixture inventories.

The broad entries are where anchors help. Narrow entries should generally stay eager.

The review also found drift in `extensions/explore/all`: its catalog entry omits current implementation files including:

- `packages/agent/extensions/explore/read-cache.ts`
- `packages/agent/extensions/explore/read-snapshots.ts`
- `packages/agent/extensions/explore/read-stats.ts`
- `packages/agent/extensions/explore/read-stats-panel.ts`

That drift is separate from anchors and should be reconciled before using `extensions/explore/all` as the pilot baseline.

## Proposed semantics

Use `anchors` as a second explicit path array:

```toml
[maintenance]
description = "Automatic validation and catalog synchronization"
files = [
  "packages/agent/extensions/context/definitions.ts",
  "packages/agent/extensions/context/sync.ts",
  "packages/agent/extensions/context/validation.ts",
]
anchors = [
  "packages/agent/test/extensions/context/sync.test.ts",
  "packages/agent/test/extensions/context/validation.test.ts",
]
```

Rules:

- `files` are project-relative regular files loaded through autoread.
- `anchors` are project-relative regular files listed in a navigation manifest without loading their contents.
- Both arrays are required in memory and normalized, sorted, and deduplicated.
- Existing TOML entries without `anchors` parse as `anchors = []`.
- An entry is valid when the union of `files` and `anchors` is nonempty. `files = []` permits a deliberately navigation-only scope.
- A path cannot appear in both arrays within one entry.
- Both classes count for stale-path checks and changed-file membership.
- If selected entries classify the same path differently, eager loading wins. Tau autoreads it once and omits it from the anchor manifest.
- V1 accepts explicit files only. Directory and glob anchors would weaken the catalog's current explicit-membership guarantee.

Per-anchor reason objects would add parser, rendering, and sync complexity. The containing entry already supplies the task-specific description. Start with path strings. Add reasons only if the pilot shows that paths and entry descriptions do not guide the model well enough.

## Agent-facing behavior

The selection should inject something close to:

```text
Selected repository context:
- extensions/context/maintenance: Automatic validation and catalog synchronization

Eager snapshots are supplied through autoread:
- packages/agent/extensions/context/sync.ts
- packages/agent/extensions/context/validation.ts

Lazy navigation anchors, not yet read:
- packages/agent/test/extensions/context/sync.test.ts
- packages/agent/test/extensions/context/validation.test.ts

Treat eager files as authoritative current snapshots. Inspect only the anchors
needed for the request. Prefer grep or bounded reads over loading every anchor.
```

The current blanket instruction in `packages/agent/extensions/context/index.ts` applies only to authoritative autoreads and discourages searching around them. It needs to distinguish eager snapshots from lazy anchors.

No public event change is needed. `tau:autoread.requested` should continue to carry eager paths only. Anchor paths belong in the injected context message.

Existing tools already fit the workflow:

- `grep` accepts multiple exact paths and returns bounded, line-numbered matches.
- `read` supports 1-indexed `offset` and `limit` values.
- The parent can pass relevant anchor paths to a subagent task when delegation is useful.

A dedicated context-inspection tool would mostly wrap `grep` and `read` without adding useful control.

## Candidate catalog split

### Keep narrow entries eager

These entries are small, instruction-bearing, or selected specifically for their contents:

- `core/repository-guidance/all`
- `skills/writing-preferences/skill`
- `repository/documentation/all`
- `repository/documentation/product-and-packages`
- `repository/documentation/contributing`
- `infrastructure/tooling/checks`
- `infrastructure/tooling/workspace`
- `extensions/context/definitions`
- `extensions/context/selection`
- `extensions/context/maintenance`
- `extensions/context/research`
- `extensions/explore/grep`
- `extensions/explore/find`
- `extensions/explore/ls`
- `extensions/explore/read`
- `extensions/explore/autoread`
- `extensions/patch/runtime`
- `extensions/patch/ui`
- `extensions/web/tests`
- `tui/shared-components/panel`
- `tui/shared-components/tabs`
- `tui/shared-components/selection`
- `tui/shared-components/visuals`
- `tui/shared-components/package-surface`

### `extensions/context/all`

Keep the runtime and its direct shared dependencies eager:

- `packages/agent/extensions/context/README.md`
- `packages/agent/extensions/context/definitions.ts`
- `packages/agent/extensions/context/index.ts`
- `packages/agent/extensions/context/panel.ts`
- `packages/agent/extensions/context/settings.ts`
- `packages/agent/extensions/context/sync.ts`
- `packages/agent/extensions/context/validation.ts`
- `packages/agent/shared/events.ts`
- `packages/agent/shared/git.ts`
- `packages/agent/shared/glob.ts`
- `packages/agent/shared/injected-context.ts`
- `packages/agent/shared/settings/load.ts`

Candidate anchors:

- `packages/agent/docs/extending-tau-agent.md`
- `packages/agent/docs/subagents.md`
- `packages/agent/extensions/subagent/agents.ts`
- `packages/agent/extensions/subagent/run.ts`
- `packages/agent/extensions/tau-help/help.md`
- `packages/agent/test/extensions/context/definitions.test.ts`
- `packages/agent/test/extensions/context/index.test.ts`
- `packages/agent/test/extensions/context/sync.test.ts`
- `packages/agent/test/extensions/context/validation.test.ts`

This would remove roughly one-third of the initial payload while preserving the complete context runtime.

### `extensions/explore/all`

Keep Explore implementation and direct shared dependencies eager. Candidate anchors:

- `packages/agent/test/extensions/explore/find.test.ts`
- `packages/agent/test/extensions/explore/grep.test.ts`
- `packages/agent/test/extensions/explore/helpers.ts`
- `packages/agent/test/extensions/explore/ls.test.ts`
- `packages/agent/test/extensions/explore/read.test.ts`
- `packages/agent/docs/extending-tau-agent.md`

Estimated saving: about 34 KB, or 8.5k initial tokens.

### `extensions/patch/all` and `extensions/patch/tests`

Keep implementation, shared dependencies, and `packages/agent/test/extensions/patch/scenarios.test.ts` eager.

Move the 75 explicit fixture paths under `packages/agent/test/extensions/patch/fixtures/scenarios/` to anchors. Keep every file explicit in V1. Their contents are small, so token savings are moderate; the larger gain is avoiding 75 separate autoread messages and unrelated scenarios competing for attention.

### `core/settings/all` and `core/settings/schema`

Candidate anchors:

- `packages/agent/schemas/tau.schema.json`
- `.pi/tau/settings.json` in `core/settings/all`
- `.pi/extensions/tau-schema-sync/README.md`

Keep the generator and schema implementation eager:

- `.pi/extensions/tau-schema-sync/index.ts`
- `packages/agent/scripts/generate-tau-schema.ts`
- `packages/agent/shared/settings/schema.ts`
- `packages/agent/shared/settings/specs.ts`

The generated schema matters during verification, but most settings work does not need it loaded at the start.

### `extensions/web/all`

Keep runtime source and `packages/agent/shared/tool-row-state.ts` eager. Candidate anchors:

- `packages/agent/extensions/web/README.md`
- `packages/agent/test/extensions/web/exa.test.ts`
- `packages/agent/test/extensions/web/helpers.ts`
- `packages/agent/test/extensions/web/html.test.ts`
- `packages/agent/test/extensions/web/tools.test.ts`
- `packages/agent/test/extensions/web/webfetch.test.ts`

Leave `extensions/web/tests` eager because selecting that entry asks for those tests directly.

## Implementation slices

### 1. Data model and parsing

Change:

- `packages/agent/extensions/context/definitions.ts`
- `packages/agent/test/extensions/context/definitions.test.ts`

Add required in-memory `anchors`, TOML parsing, normalization, overlap rejection, and union-nonempty validation.

### 2. Selection, manifest, and panel

Change:

- `packages/agent/extensions/context/index.ts`
- `packages/agent/extensions/context/panel.ts`
- `packages/agent/test/extensions/context/index.test.ts`
- `.pi/extensions/tool-preview/widgets/context.ts`

The panel should label eager and anchor paths separately. Tests should prove that only eager paths reach `tau:autoread.requested` and that anchors appear in hidden injected context. A focused panel test would cover rendering and eager-wins deduplication.

### 3. Validation

Change:

- `packages/agent/extensions/context/validation.ts`
- `packages/agent/test/extensions/context/validation.test.ts`

Membership and stale checks must use both arrays. Cover an anchored changed file, a missing anchor, and an eager/anchor overlap.

### 4. `context_sync`

Change:

- `packages/agent/extensions/context/sync.ts`
- `packages/agent/test/extensions/context/sync.test.ts`
- `packages/agent/test/extensions/context/index.test.ts`

Recommended policy:

- The model proposes desired entry membership as one union of paths.
- Existing retained paths keep their eager or anchor classification.
- Newly added paths default to eager.
- Renamed anchor targets default to eager until manually demoted.
- Sync never promotes or demotes a retained path on its own.
- Applying a plan serializes and preserves both arrays.

This keeps loading policy deliberate and prevents repeated model-driven classification churn.

### 5. Documentation and pilot catalog migration

Change:

- `packages/agent/extensions/context/README.md`
- `packages/agent/extensions/tau-help/help.md`
- selected `.pi/contexts/**/*.toml`

Likely pilot catalogs:

- `.pi/contexts/extensions/context.toml`
- `.pi/contexts/extensions/explore.toml`

No Tau settings schema change is needed because anchors belong to context TOML rather than extension settings.

## Main risks

### Validation currently sees one path class

`packages/agent/extensions/context/validation.ts` builds memberships from `entry.files`. Anchors would otherwise appear uncovered and missing anchors would not be reported as stale.

### Sync currently destroys unknown entry fields

`applyContextSyncPlan` replaces a touched entry with `{ description, files }`. Adding anchors only to the parser would let a later sync silently erase them.

Most sync calculations also assume `entry.files`: affected-entry discovery, stale detection, memberships, sibling files, orphan prevention, final coverage, prompt serialization, and existence checks all need union semantics.

### Model-controlled classification would churn

If `submit_context_sync` asks the model to return eager and anchor arrays, routine reconciliation can repeatedly promote and demote files. Classification should remain deterministic and curated.

### Sync prompt pressure already exists

`context_sync` serializes the complete catalog into a prompt capped at 64,000 characters. Adding another key increases structural overhead even when paths merely move between arrays. Dirty evidence must remain present after truncation; a regression test should cover this.

### Anchors solve model input pressure, not filesystem I/O

Ranged `read` bounds returned model content, but the current implementation reads a full local file before slicing. `grep` also reads searched files. This proposal reduces tokens and attention pressure. It does not reduce local disk reads.

### Anchor-only scopes can be too weak

Allowing `files = []` is useful for navigation-only entries, but broad anchor-only scopes can leave the agent without enough initial vocabulary to search effectively. The pilot should keep an eager nucleus and use anchor-only entries only when their paths and entry description give a clear starting point.

## Pilot experiment

Start with `extensions/explore/all` after reconciling its catalog drift.

Move these paths to anchors:

- `packages/agent/test/extensions/explore/find.test.ts`
- `packages/agent/test/extensions/explore/grep.test.ts`
- `packages/agent/test/extensions/explore/helpers.ts`
- `packages/agent/test/extensions/explore/ls.test.ts`
- `packages/agent/test/extensions/explore/read.test.ts`
- `packages/agent/docs/extending-tau-agent.md`

Run the same task in fresh sessions against current eager behavior and the pilot:

> Select `extensions/explore/all`. Find the test proving broad grep output remains bounded, explain what bounds it, and cite the exact test and implementation paths. Do not inspect unrelated tests.

Expected lazy navigation:

1. Grep the anchor paths for the bounded-output test.
2. Range-read the matching section of `packages/agent/test/extensions/explore/grep.test.ts`.
3. Use the already eager `packages/agent/extensions/explore/grep.ts` to explain the implementation.

Success criteria:

- At least 25% lower initial context payload for `extensions/explore/all`.
- No full-file reads of unrelated anchors.
- At most one grep and two ranged reads.
- The answer cites the exact test and implementation paths.
- The factual result matches the eager baseline.
- Total model input remains at least 20% lower after including navigation tool results.
- Unit tests prove eager-only autoread, anchor manifest injection, eager-wins deduplication, validation coverage, stale-anchor reporting, and sync round-trip preservation.

If the pilot meets those criteria, migrate `extensions/context/all` next. `extensions/patch/all` should follow for message-count and attention savings. Avoid a catalog-wide conversion until both pilots show that the model navigates anchors instead of reading all of them reflexively.
