# Explore Technical Plan

## First Action

Delete `src/extensions/search/` and `test/extensions/search/` without opening or reading files inside those directories.

The replacement must be implemented from `docs/plans/explore.spec.md`, this technical plan, Pi APIs, and focused shared/patch/preview files only. No implementation agent should inspect old search tool files for algorithms, formatting, or structure.

This can temporarily break checks during the branch. Restore green by adding `explore` and the new tests in the order below.

## Read First

- `docs/plans/explore.spec.md` whole file. Product truth.
- `package.json:12-13`. First-party extension index files are loaded by glob.
- `.pi/settings.json:5-8`. Local Tau settings currently mention `patch` and disabled `search`.
- `src/shared/events.ts:1-86`. Existing typed Tau event helper.
- `/Users/shanepadgett/.local/share/tau-agent/references/pi/packages/coding-agent/src/core/extensions/types.ts:398-424`. Tool render context includes `toolCallId`, `lastComponent`, `expanded`, and `isError`.
- `/Users/shanepadgett/.local/share/tau-agent/references/pi/packages/coding-agent/src/modes/interactive/components/tool-execution.ts:116-128`. Tool rows pass stable render context per tool call.
- `/Users/shanepadgett/.local/share/tau-agent/references/pi/packages/coding-agent/src/index.ts:190-266`. Pi exports tool factories and tool-definition factories.
- `/Users/shanepadgett/.local/share/tau-agent/references/pi/packages/coding-agent/src/core/tools/read.ts:279-345`. Built-in read content, continuation, truncation, image payload, and render hooks.
- `src/extensions/patch/index.ts:137-171` and `src/extensions/patch/render.ts:171-214`. Patch render seam for shared row-state adoption.
- `.pi/extensions/tool-preview/widgets/tool-preview.ts:1-126`. Approved preview scaffold and collapsed-error bug.
- `.pi/extensions/tool-preview/widgets/grep.ts:8-161`. Stale raw-argv grep preview samples to replace with structured-query samples.

Do not read `src/extensions/search/**` or `test/extensions/search/**`. Broaden other reads only when the implementation contradicts the listed facts or a failing type/test result gives a concrete reason.

## Old Search Behavioral Facts Already Carried Forward

No old search implementation algorithm needs to be preserved.

Behavior that matters has already moved into the spec or this plan:

- The old extension registered names that collide with `explore`; deleting the directory removes that collision under the `package.json` extension glob.
- The old extension had `forget`, auto-read, startup workspace maps, settings, and context-pruning behavior; none of that moves into `explore`.
- The old `test/extensions/search/` tests cover old working-memory behavior; delete them with the old extension.
- The local `.pi/settings.json` search disable entry becomes stale after deletion; remove that entry.
- The Explore replacement uses the public args, render shapes, payload shapes, defaults, limits, and error behavior in `docs/plans/explore.spec.md`.
- The useful old path convenience is leading-`@` stripping for path and glob inputs; the spec now carries that behavior.
- The useful old output behavior is deterministic ordering; the spec now carries directory-first/name sorting for path trees and path/line sorting for grep groups.
- The useful old safety behavior is bounded internal content-search output; this plan carries that behavior for `grep`.

Old behaviors not to preserve:

- Do not cap `ls` depth at 3 unless the spec is changed.
- Do not treat a missing `ls` path as a fake file entry; return an error.
- Do not add hidden/noise/gitignored omission-count footers.
- Do not add find extension-summary footers.
- Do not allow raw `rg` argv passthrough or native output modes.
- Do not add search evidence metadata, search memory metadata, or status words.

## Code Ladder

1. Need exists: yes. The spec replaces the old `search` surface with `explore` owning `ls`, `find`, `grep`, and `read`.
2. Repo pattern: use Pi extension/tool APIs and render context. Do not copy old `search` tool code.
3. Small refactor first: add shared row-state helper before wiring explore and patch renderers.
4. Stdlib/platform: use Node path/fs traversal and platform/git ignore behavior where it keeps code smaller and clearer.
5. Native platform: use the filesystem and Git/ripgrep behavior where that is the simplest correct mechanism for ignored files and content search.
6. Existing dependency: use TypeBox schemas and Pi's built-in read tool factory/definition. Add no dependency unless the implementation cannot satisfy the spec cleanly without it.
7. One line: keep formatting helpers local until two tool files need the same named concept.
8. Else smallest code that satisfies the spec and tests.

## Boundaries

Do not import from `src/extensions/search/*` in the new implementation. The old implementation is retirement evidence, not source material.

Do not add `settings.ts` for `explore`. The spec defines no user settings.

Do not add focus, pruning policy, auto-read, startup workspace maps, `forget`, or working-memory behavior to `explore`.

Do not add raw shell/ripgrep argv as a public `grep` input.

Do not add routine stats footers to `ls`, `find`, or `grep`.

## Files

### Add `src/shared/tool-row-state.ts`

Own generic custom tool row visual state.

Shape:

- `ToolRowVisualState = "pruned"`.
- A small store created from an extension API or event API.
- A helper that returns the tool title string for a `toolCallId`, tool name, and theme.
- Default title uses `toolTitle` color.
- `pruned` title uses `warning` color.
- No helper returns visible status words.

The store should subscribe to one shared Tau event and update by `toolCallId`. It should clear per session if Pi exposes a clean session lifecycle hook at the call site.

### Update `src/shared/events.ts`

Add one event to `TauAgentEvents` for shared row state, for example:

```ts
"tau:tool-row-state.set": {
	toolCallId: string;
	state?: ToolRowVisualState;
};
```

Keep the payload minimal. No pruning policy data belongs here.

### Add `src/extensions/explore/index.ts`

Register exactly four tools:

- `ls`
- `find`
- `grep`
- `read`

Create one row-state store and pass it to each tool definition factory.

No settings load. No context hooks. No startup prompt injection. No event listeners except row-state store setup if the helper needs it.

### Add `src/extensions/explore/README.md`

Product-level README only:

- what Explore is,
- why it exists,
- how users invoke `ls`, `find`, `grep`, and `read`.

No implementation notes.

### Add `src/extensions/explore/result.ts`

Own the model-payload versus human-render split for explore text tools.

Boundary:

- `content[0].text` is always the model-facing payload.
- `details.humanText` carries the expanded human-readable body when it differs.
- Renderers use `details.humanText ?? content[0].text` for expanded rows.
- Collapsed renderers return empty body for success and error.

This file earns keep because `ls`, `find`, and `grep` must not accidentally send the readable tree when the compact payload is intended.

### Add `src/extensions/explore/path-tree.ts`

Own tree rendering shared by `ls` and `find`.

Boundary:

- Input is normalized entries with display path, type, and optional metadata.
- Human output: directory tree, trailing `/` for directories, two-space indentation, `[empty]` marker.
- Agent output: compact grouped paths, comma-joined sibling basenames, indented nested groups.
- Omission notices are appended unchanged to both human and agent output.

Do not put traversal, glob matching, grep matches, or tool schemas here.

### Add path helper only after duplication appears

If two or more tool files need the same path resolution/display/filtering code, add a focused helper under `src/extensions/explore/` with a grep-useful name such as `path-display.ts` or `path-filter.ts`.

Keep these boundaries separate:

- display/relative/absolute formatting,
- leading-`@` stripping for path and glob inputs,
- hidden/noise/gitignore filtering,
- traversal.

Do not create a mixed `utils.ts`.

### Add `src/extensions/explore/ls.ts`

Own the `ls` schema, execution, result shaping, and renderer.

Responsibilities:

- Accept only `paths?`, `depth?`, `limit?`, `all?`, `long?`.
- Resolve omitted/empty `paths` to `.`.
- Apply default depth and limit from the spec.
- Divide budget across requested roots.
- Produce normalized entries for `path-tree.ts`.
- Return compact model payload through `content[0].text`.
- Return human tree through `details.humanText` when different.
- Render initial call with effective args.
- Render collapsed result body as empty, including errors.
- Render expanded errors with the error text.

### Add `src/extensions/explore/find.ts`

Own the `find` schema, execution, result shaping, and renderer.

Responsibilities:

- Accept only `queries` and `limit?` at top level.
- Accept only `path?`, `patterns?`, `type?`, `maxDepth?`, `hidden?`, and `noIgnore?` per query.
- Validate `type` as `file`, `dir`, or `any`.
- Resolve omitted query path to `.`.
- Apply basename versus relative-path pattern behavior from the spec.
- Divide budget across queries.
- Group multi-query output with `query N` for human text and `qN` for model text.
- Use `path-tree.ts` for one-query and per-query tree formatting.
- Render states the same way as `ls`.

### Add `src/extensions/explore/grep.ts`

Own the `grep` schema, execution, result shaping, and renderer.

Responsibilities:

- Accept only structured query objects.
- Reject raw argv-array queries by schema or explicit validation.
- Require at least one pattern per query.
- Implement literal and regex search semantics from the spec.
- Implement case, word, context, context-only, include, exclude, hidden, no-ignore, limit, max-per-file, and max-line-length behavior.
- Divide budget across queries.
- Group one-query output by file.
- Group multi-query output by query and file.
- Sort file groups by displayed path and lines by line number.
- Keep internal search output bounded. If using a subprocess, stream results or cap stdout/stderr so a broad search cannot fill memory before tool limits apply.
- If using ripgrep internally, treat exit code 1 as no matches and any other non-zero or spawn failure as a tool error.
- Use the same grouped text for human expanded output and model payload unless a later implementation finds a clear reason to split.
- Render initial call from structured args, not synthetic `rg` argv.
- Render states the same way as `ls`.

The executor may use ripgrep internally if that is the smallest correct mechanism. That internal command construction must not leak into the public argument surface.

### Add `src/extensions/explore/read.ts`

Own the Explore `read` registration wrapper and renderer.

Responsibilities:

- Keep the public args exactly `path`, `offset?`, and `limit?`.
- Delegate file reading, image handling, byte/line truncation, and continuation wording to Pi's built-in read implementation.
- Preserve returned text content exactly for model payload.
- Preserve built-in image content blocks.
- Custom rendering may change the title color and collapsed/expanded body behavior only.
- Render collapsed result body as empty, including errors.
- Render expanded text and errors from the built-in result content.

Do not reimplement read truncation or image processing.

### Update `src/extensions/patch/index.ts` and `src/extensions/patch/render.ts`

Make patch participate in shared row-state rendering.

Small seam:

- Create/pass the same row-state store type used by explore.
- Pass `context.toolCallId` into patch render functions.
- Replace hardcoded patch title coloring with the shared title helper.
- Preserve all existing patch result, summary, and operation rendering.

Expected visible change: none unless a row-state event marks the patch tool call as `pruned`; then only the patch title color changes.

### Update `.pi/extensions/tool-preview/widgets/tool-preview.ts`

Fix generic preview rendering so collapsed error results are command-only.

Current bad condition is `expanded || context.isError`. Replace with expanded-only body rendering. Expanded errors still show the error body.

Keep existing preview sections:

- `Agent Payload`
- `Initial Call`
- `Collapsed Result`
- `Expanded Result`
- `Pruned Result`

### Update `.pi/extensions/tool-preview/widgets/grep.ts`

Replace raw argv-array samples with structured query-object samples matching the spec.

Cover at least:

- literal multi-pattern query,
- no matches,
- context lines,
- context-only,
- max-per-file,
- max-line-length,
- multiple queries,
- hidden/no-ignore,
- limit hit,
- invalid regex error.

Use `agentResult` only when it differs from the rendered result.

### Update other preview samples only when stale

Change `ls`, `find`, or `read` preview sample paths that point at retired `src/extensions/search/` files when the sample claims to represent the Explore surface.

Patch preview samples can keep generic patch paths if they still demonstrate patch states clearly.

## Retire Search

Delete `src/extensions/search/` as the first implementation action. Do not open files inside it first.

Delete `test/extensions/search/` with it. Do not open files inside it first. Those tests cover search working-memory behavior that does not move into `explore`.

Update `.pi/settings.json` to remove the stale `-src/extensions/search/index.ts` entry after the file is gone. Do not add an explicit `+src/extensions/explore/index.ts` unless local package loading proves the glob does not load it.

Do not edit `schemas/tau.schema.json` manually. If deleting `src/extensions/search/settings.ts` changes Tau schema output, let tau-schema-sync regenerate it.

Leave historical plan/research docs alone unless they are imported by checks or rendered as current product docs.

## Tests

Add `test/extensions/explore/`.

Prefer one test file per tool when it lowers future read surface:

- `ls.test.ts`
- `find.test.ts`
- `grep.test.ts`
- `read.test.ts`

Add `test/shared/tool-row-state.test.ts` if shared row-state behavior has logic beyond title-color selection.

Use temp directories and files. Do not rely on current repository layout for behavior tests.

Test `ls`:

- default path/depth/limit,
- leading `@` path normalization,
- deterministic directory-first name sorting,
- file path root,
- empty directory,
- multiple roots with divided budget,
- hidden/noise/gitignored default filtering,
- `all: true`,
- `long: true`,
- limit notice,
- missing path error,
- collapsed error body empty,
- expanded error body visible.

Test `find`:

- omitted path,
- leading `@` path and glob normalization,
- deterministic directory-first name sorting,
- omitted patterns,
- basename pattern,
- relative-path pattern containing `/`,
- `file`, `dir`, and `any`,
- `maxDepth`,
- hidden/no-ignore switches,
- noise paths included only when `noIgnore` is true,
- multiple queries with `qN` model payload grouping,
- limit notice,
- no matches,
- missing path error.

Test `grep`:

- raw argv query rejected,
- literal search,
- leading `@` path/glob normalization,
- regex search,
- invalid regex error,
- smart/sensitive/insensitive case,
- word matching,
- include/exclude globs,
- hidden/no-ignore switches,
- context lines,
- context-only,
- multiple queries,
- deterministic file-group and line ordering,
- limit notice,
- max-per-file notice,
- max-line-length truncation,
- no matches,
- missing path error,
- internal broad-search output stays bounded.

Test `read`:

- delegates plain text content unchanged,
- offset is 1-indexed,
- limit continuation text is preserved,
- built-in truncation text is preserved using a generated large file,
- missing path error,
- directory path error,
- offset past EOF error,
- collapsed error body empty,
- expanded error body visible.

Test shared row state/rendering:

- normal title uses tool-title color,
- `pruned` title uses warning color,
- no status word is emitted,
- changing row state does not mutate saved result content.

## Implementation Order

1. Delete `src/extensions/search/` and `test/extensions/search/` without reading their contents.
2. Remove the stale `-src/extensions/search/index.ts` entry from `.pi/settings.json`.
3. Add shared row-state event type and helper.
4. Wire patch title rendering through the helper without changing patch output.
5. Add Explore skeleton, README, and result/tree helpers.
6. Add `read` by delegating to Pi built-in read and wrapping render behavior.
7. Add `ls` and `find`, sharing only path-tree formatting that both use.
8. Add `grep` with structured query validation and internal search execution.
9. Update tool-preview helper and stale grep samples.
10. Add or update tests for the new behavior.
11. Let automatic checks run; do not manually run the forbidden aggregate check command.

## Done

- `explore` registers `ls`, `find`, `grep`, and `read`.
- Old `search` no longer registers tools or settings from the first-party extension glob.
- `forget` and working-memory behavior are absent from `explore`.
- `ls` and `find` send compact model payloads and render readable expanded trees.
- `grep` accepts structured queries only.
- `read` preserves Pi built-in continuation, truncation, and image behavior.
- Collapsed success and error rows are command-only.
- Pruned row state changes title color only.
- Patch can use the same row-state helper.
- Preview samples match the approved render and agent-payload shapes.
