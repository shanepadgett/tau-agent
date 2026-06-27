# Search technical plan

## Intent

Build a Tau `search` extension that owns `read`, `grep`, `find`, and `ls`, adds RTK-style compact search/list output, injects one startup workspace map, and optionally manages working-memory pruning through a setting.

## Code Ladder

1. Need exists: yes. Built-in `grep`, `find`, and `ls` do not encourage batched token-efficient exploration, and existing working-memory coupling keeps search behavior split across the wrong boundary.
2. Repo pattern: reuse `defineTool`, `pi.registerTool`, TypeBox schemas, prompt snippets/guidelines, settings files under extension directories, existing working-memory pruning ideas, and Pi built-in `read` implementation/rendering.
3. Small refactor first: collapse `working-memory` into `search` so file discovery/search/read evidence and its lifecycle live in one product boundary.
4. Stdlib/native: use Node `fs`/`path`/`child_process`; use `git check-ignore` for ignored-path filtering.
5. Platform: use `rg` for content search and gitignore-aware file discovery.
6. Existing dependency: use existing pi packages and TypeBox. Do not add dependencies unless local matching proves wrong.
7. One line does not satisfy batched schemas, compact formatting, evidence metadata, or startup map.
8. Smallest correct shape: one `src/extensions/search/` extension with one file per public tool, a small evidence contract, one pruning policy file, and local ripgrep/path helpers only because multiple search files use them.

## Boundary decisions

### Extension seam

- Create `src/extensions/search/`.
- Move the useful working-memory behavior into `search`.
- Delete `src/extensions/working-memory/` after migration so the extension glob does not load duplicate tool registrations.
- Register public tool names from search: `read`, `grep`, `find`, `ls`.
- Register `forget` only as a search memory tool and keep it active only when `workingMemory` is enabled.
- Search owns startup workspace map injection because the map is just `ls` output at session start.

### Tool seam

Each tool file owns its own schema, prompt metadata, execution, evidence building, and renderer:

- `read.ts`
- `grep.ts`
- `find.ts`
- `ls.ts`
- `forget.ts`

No central `renderers.ts`. If a tool’s arguments/output change, the agent should read that tool file only.

### Memory seam

Working memory is not an extension. It is a setting inside `search`.

Memory files stay only where they represent real policy boundaries:

- `evidence.ts`: evidence contract, builders, and parsers.
- `context-pruning.ts`: stale/outdated/forgotten/irrelevant lifecycle policy.
- `mutation-memory.ts`: patch/tau-edit reaction that emits auto-read/path-update messages.
- `memory-messages.ts`: auto-read/path-update custom message formats and parsers. Inline this into `mutation-memory.ts` if it stays tiny after implementation.

### Helper seam

- `ripgrep.ts` stays local to search because only search tools use `rg`.
- `path-utils.ts` stays local to search for the first implementation. These helpers encode search semantics: leading `@`, cwd-relative display, inside-cwd safety, and search/noise omissions. Move them to `src/shared/` only when another extension actually imports the same semantics.
- No `workspace-map.ts`; startup map is built by `ls.ts`.
- No `fs/` folder.

## Settings

### Add `src/extensions/search/settings.ts`

Tau settings live next to `index.ts`.

Schema:

```ts
{
	workingMemory?: boolean;
	excludedPaths?: string[];
}
```

Defaults:

```ts
{
	workingMemory: true,
	excludedPaths: []
}
```

Behavior when `workingMemory` is false:

- `read`, `grep`, `find`, and `ls` still work normally.
- No context pruning.
- No memory prompt guidance.
- No mutation auto-read/path-update messages.
- `forget` is removed from active tools on `session_start` and guarded if called anyway.
- Tool details may still include search evidence, but no memory lifecycle consumes it.

Do not preserve the old `working-memory` settings key unless explicitly requested.

## Files

### Add `src/extensions/search/index.ts`

Responsibilities:

- Load `search` settings on `session_start`.
- Register `read`, `grep`, `find`, `ls`, and `forget`.
- Keep `forget` active only when `settings.workingMemory` is true.
- Register auto-read/path-update message renderers.
- Subscribe to patch and `tau:context.snapshot` events only when working memory is enabled.
- Add search prompt guidance through tool prompt metadata.
- Add working-memory prompt guidance only when working memory is enabled.
- Inject startup workspace map once per session on the first `before_agent_start`, independent of working-memory setting.
- Do not reinject startup workspace map after compaction.

### Add `src/extensions/search/README.md`

Product-level only.

Content:

- Explain Tau Search provides `read`, `grep`, `find`, and `ls` for compact file exploration.
- Explain `workingMemory` optionally prunes stale/forgotten search evidence and enables `forget`.
- Explain gitignore/noise respecting defaults and narrow opt-in for ignored/noise paths.
- No implementation details.

### Add `src/extensions/search/evidence.ts`

Purpose: stable contract between tools and memory lifecycle.

Details shape:

```ts
{
	searchEvidence: {
		version: 1;
		kind: "read" | "grep" | "find" | "ls" | "auto-read" | "path-update" | "forget";
		role: "current" | "navigation" | "inventory" | "mutation" | "memory-action";
		paths: string[];
		complete: boolean;
		toolCallId?: string;
	}
}
```

Rules:

- Tools emit evidence metadata; pruning consumes evidence metadata.
- Pruning must not parse grep/find/ls output text for paths when evidence is present.
- Keep text parsing only as a migration fallback if tests prove old sessions need it. Otherwise delete old parsing.
- `read` whole-file evidence is `role: "current"` and `complete: true`.
- partial/truncated `read` evidence is not current.
- `grep` and `find` evidence is `role: "navigation"`.
- `ls` evidence is `role: "inventory"`.
- auto-read evidence is `role: "current"`.
- path-update evidence is `role: "mutation"`.

### Add `src/extensions/search/context-pruning.ts`

Purpose: working-memory lifecycle policy.

Statuses:

- `outdated`: automatic status for evidence replaced by newer/current evidence or invalidated by mutation/path update. This collapses old `stale` and `superseded` UI states.
- `forgotten`: explicit agent action after evidence served its purpose and surviving facts are in the checkpoint.
- `irrelevant`: explicit agent action for dead-end/no-value evidence.

Policy:

- Whole-file `read` and auto-read evidence for a path make older current/navigation evidence for that same path outdated.
- New current evidence for the same path makes older current evidence outdated.
- Mutation path-update evidence makes older evidence for changed paths outdated.
- `grep`/`find` navigation evidence can become outdated when all referenced paths now have current evidence.
- `ls` inventory evidence is not outdated merely because one contained file was read. It becomes outdated through explicit forget, newer overlapping inventory evidence, or path mutation under that inventory scope.
- `forget` marks eligible prior evidence as `forgotten` or `irrelevant` according to its disposition.
- Never prune failed checks, unresolved errors, user requirements, active decisions, or mutation failure evidence.

### Add `src/extensions/search/mutation-memory.ts`

Purpose: produce current evidence after mutations.

Behavior:

- Listen for `tau:file-mutation.applied` from `patch` only when working memory is enabled.
- For changed small repo files, emit auto-read messages.
- For created/moved/deleted/changed-but-not-auto-read paths, emit path-update messages.
- Use `excludedPaths`, dependency/noise checks, gitignore checks, and max-size checks before auto-read.
- Listen for `tau:context.snapshot` and emit auto-read messages for tau-edit snapshots.

### Add `src/extensions/search/memory-messages.ts`

Message names:

- Custom type `tau.search.auto-read`.
- Custom type `tau.search.path-update`.

Terminology:

- Use “auto read”, not “reread”.
- Use “path update”, not “reread skipped”.

Rendering:

- Auto-read renders the file path in the same visual style as the `read` tool path.
- Path update renders the new path for created/moved/changed paths.
- Deleted path updates render the deleted path because no new path exists.
- Expanded auto-read shows the file content.
- Expanded path update shows compact change lines.

### Add `src/extensions/search/read.ts`

Purpose: wrap Pi built-in `read` without changing its visual behavior.

Implementation:

- Use Pi `createReadToolDefinition` for execution and built-in rendering.
- Merge search evidence into result details without removing built-in `truncation` details.
- Render call/result exactly like built-in `read`.
- Add only memory status markers (`outdated`, `forgotten`, `irrelevant`) as a suffix/wrapper when working memory marks that tool call.
- Keep existing Tau guidance: repo-owned work files should be read wholly; offset/limit only for external docs, dependencies, vendor/generated files, or huge non-work files.

Evidence:

- Whole untruncated reads with no offset/limit emit `role: "current"`, `complete: true`.
- Offset/limited/truncated reads emit non-current evidence or no current evidence.
- Image reads do not become current file-content evidence unless implementation can prove useful text content exists.

### Add `src/extensions/search/grep.ts`

Schema:

```ts
{
	queries: string[][];
	limit?: number;
	maxPerFile?: number;
	maxLineLength?: number;
	contextOnly?: boolean;
}
```

Defaults:

- `limit: 100` shown match/context lines.
- `maxPerFile: 8` shown lines per file per query.
- `maxLineLength: 200` visible characters.
- `contextOnly: false`.

Execution:

1. Treat each query as argv. Never shell-join.
2. Passthrough help/version and already-compact/non-match modes: `--json`, `-l`, `-L`, `-c`, `-o`, `-q`, `--files`, `--vimgrep`, `--column`, NUL modes, and byte-offset modes.
3. For compact mode, run `rg --json --line-number --with-filename` plus query args via `ripgrep.ts`.
4. Exit code `0` means matches. Exit code `1` means no matches. Other exit codes are clear errors.
5. Parse JSON `match` and `context` events.
6. Group by exact path and line.
7. Sort groups by path and line.
8. Allocate `limit` fairly across queries; reuse spare capacity.
9. Enforce `maxPerFile` per file per query.
10. Truncate match lines around the first match span with `…` markers.
11. Format match lines as `path:line: text` and context lines as `path-line- text`.
12. Format summaries as bracket-prefixed lines, e.g. `[query 2: shown 40/93, omitted 53, files 7]`.
13. Add `[loc: path:lineCount]` metadata for matched files when available.
14. If compact output would be larger than native-compatible output, return native-compatible output for that query.

Evidence:

- Emit navigation evidence for matched paths.
- Do not use `details.truncation` for normal result caps; that key belongs to Pi truncation semantics.

Prompt metadata:

- Name `grep` in every prompt guideline.
- Tell agent to batch related content searches in one `grep` call.
- Tell agent to use multiple `-e` patterns inside one query when paths/flags match.
- Tell agent to use multiple query arrays when paths/flags differ.
- Tell agent to use limits/globs/paths instead of `bash rg | head | awk | cut | wc`.
- Tell agent to use `--no-ignore` or `-u` only with narrow paths/globs for ignored content.

Renderer:

- Keep renderer in `grep.ts`.
- Render query count and short argv preview.
- Append memory status marker when present.

### Add `src/extensions/search/find.ts`

Schema:

```ts
{
	queries: Array<{
		path?: string;
		patterns?: string[];
		type?: "file" | "dir" | "any";
		maxDepth?: number;
		noIgnore?: boolean;
		hidden?: boolean;
	}>;
	limit?: number;
}
```

Defaults:

- Query path `.`.
- Query patterns `[]` means all discovered paths.
- Query type `any`.
- `hidden: false`.
- `noIgnore: false`.
- `limit: 100` total shown paths.

Execution:

1. Resolve query path with `path-utils.ts`.
2. Run `rg --files` through `ripgrep.ts`.
3. Add `--hidden`, `--no-ignore`, and `--max-depth` only when requested.
4. Pass query path to `rg --files` so ignored opt-in stays narrow.
5. Filter returned files to resolved query path.
6. Filter by filename glob patterns. If a pattern contains `/`, match relative path; otherwise match basename.
7. For `type: file`, return files.
8. For `type: dir`, derive directories from returned files.
9. For `type: any`, include files and containing directories.
10. Sort and dedupe paths.
11. Allocate `limit` fairly across queries.
12. Group output by directory.
13. Include compact per-query summaries, shown/omitted counts, directory counts, and extension summaries.
14. Report `rg` failures clearly. Exit code `1` means no files.

Evidence:

- Emit navigation evidence for shown and matched paths when known.

Known limitation:

- Empty directories may be omitted because initial directory results derive from files. If evals show pain, add Node directory walk with gitignore checks.

Renderer:

- Keep renderer in `find.ts`.
- Render query count and short pattern/type/path preview.
- Append memory status marker when present.

### Add `src/extensions/search/ls.ts`

Schema:

```ts
{
	paths?: string[];
	depth?: number;
	limit?: number;
	all?: boolean;
	long?: boolean;
}
```

Defaults:

- `paths: ["."]`.
- `depth: 1`.
- `limit: 100` total shown entries.
- `all: false`.
- `long: false`.

Execution:

1. Resolve paths with `path-utils.ts`.
2. Stat each path.
3. If file, emit file entry.
4. If directory, read sorted entries.
5. When `all` is false, omit hidden names, noise dirs, and gitignored paths.
6. Use batched `git check-ignore --stdin` for gitignored checks.
7. Recurse to clamped depth `0..3`.
8. Allocate `limit` fairly across requested paths.
9. Format directories before files.
10. Compact output uses names/counts only.
11. Long output adds compact mode/size/mtime metadata.
12. Summarize hidden/noise/gitignored omissions on bracket-prefixed lines.

Startup map:

- Export `buildStartupWorkspaceMap(cwd: string, signal?: AbortSignal): Promise<string>` from `ls.ts`.
- Use the same inventory formatter.
- Use `paths: ["."]`, `depth: 3`, `all: false`, `long: false`.
- Enforce around 4 KB hard budget.
- Prefix with `Workspace map (startup; gitignored/noise omitted):`.
- Append instruction: `Use ls for deeper/current structure; use all=true only for narrow ignored/noise paths.`
- Return a compact unavailable line on unexpected errors.

Evidence:

- Emit inventory evidence for listed path scopes and shown entries.

Renderer:

- Keep renderer in `ls.ts`.
- Render batched paths, depth, all/long flags, and limit.
- Append memory status marker when present.

### Add `src/extensions/search/forget.ts`

Schema:

```ts
{
	keep: string;
	paths?: Array<{ path: string; rereadIf?: string }>;
	recent?: number;
	disposition?: "done" | "irrelevant";
}
```

Behavior:

- Active only when `workingMemory` is true.
- `disposition: "done"` marks evidence as `forgotten`.
- `disposition: "irrelevant"` marks evidence as `irrelevant`.
- Default disposition is `done`.
- `paths` targets path evidence.
- `recent` targets recent eligible successful non-mutation results.
- `keep` is the retained checkpoint.
- Never forget user requirements, active decisions, mutation results, failed checks, or unresolved errors.

Prompt guidance:

- Use `forgotten`/default for successful exploration that has served its purpose.
- Use `irrelevant` for dead-end/no-value exploration.
- Include concrete `rereadIf` for path evidence.

### Add `src/extensions/search/path-utils.ts`

Local search semantics only.

Exports likely needed:

- strip leading `@`.
- resolve search paths relative to cwd.
- convert absolute paths to cwd-relative display paths.
- inside-cwd checks.
- search noise dirs: `.git`, `node_modules`, `dist`, `build`, `coverage`, `.cache`, `.next`, `.turbo`, `.parcel-cache`, `out`.
- simple glob matching for search patterns.

Do not add broad path helpers. Move to `src/shared/` only after another extension needs these exact helpers.

### Add `src/extensions/search/ripgrep.ts`

Local runner used by `grep.ts` and `find.ts`.

Responsibilities:

- Spawn `rg` without shell.
- Capture stdout/stderr separately with byte caps.
- Kill on abort.
- Return exit code, stdout, stderr, and cap flags.
- Report missing `rg` clearly.

No grep parsing. No find filtering.

## Existing file changes

### Delete/move `src/extensions/working-memory/*`

- Move useful code into `src/extensions/search/`.
- Delete old files after imports/tests are updated.
- Do not leave `src/extensions/working-memory/index.ts`, because the extension glob would load both old and new tool registrations.

### Update `src/extensions/soul/index.ts` and `src/extensions/soul/prompt.ts`

- Remove startup workspace-map responsibility from soul if prior plan added it.
- No change needed if implementation has not touched soul yet.
- Search owns workspace map injection.

## Eval scaffold

### Add `docs/evals/search-tools.md`

Markdown only. Not wired into automated checks.

Content:

- Purpose and setup.
- Fixture instructions for a temporary repo with ignored dependency-like paths, noise dirs, nested source dirs, long matching lines, repeated matches, multiple plausible search terms, and files whose names require `find`.
- Agent task using only `grep`, `find`, `ls`, and `read` except explicitly allowed setup commands.
- Expected behavior checklist: batched grep queries, batched find queries, batched ls paths, narrow ignored-path opt-in, no bash search/list pipelines.
- Working-memory-on run: verify outdated/forgotten/irrelevant markers and `forget` behavior.
- Working-memory-off run: verify tools work normally and no pruning/forget guidance appears.
- Manual feedback log template: tool, args summary, success/failure, output bytes/lines, omitted/truncated counts, batching notes, call counts.

## Tests

Add focused tests under `test/extensions/search/`.

Suggested files:

- `test/extensions/search/read.test.ts`
  - verifies built-in read output/details are preserved,
  - verifies search evidence is merged,
  - verifies renderer delegates built-in visual shape and appends only memory marker.
- `test/extensions/search/grep.test.ts`
  - verifies grouped exact-path output,
  - verifies match-centered truncation,
  - verifies per-file/per-query caps,
  - verifies bracket summaries,
  - verifies `[loc: ...]` footer.
- `test/extensions/search/find.test.ts`
  - verifies grouped output,
  - verifies basename/path glob filtering,
  - verifies extension summary and omitted counts.
- `test/extensions/search/ls.test.ts`
  - verifies dirs/files grouping,
  - verifies hidden/noise omission summary,
  - verifies `all: true`,
  - verifies startup map budget.
- `test/extensions/search/context-pruning.test.ts`
  - verifies current read makes older navigation evidence outdated,
  - verifies mutation path update makes old evidence outdated,
  - verifies `forget disposition: done` marks forgotten,
  - verifies `forget disposition: irrelevant` marks irrelevant,
  - verifies `ls` inventory is not outdated by reading one contained file.
- Move/update existing working-memory behavior tests into search tests.

Avoid tests that require real `rg` where pure parser/formatter tests cover behavior. If execution-level tests are added, skip when `rg` is missing.

## Implementation order

1. Create `src/extensions/search/settings.ts`.
2. Add `evidence.ts` and update pruning tests around evidence metadata.
3. Move/refactor context pruning into `search/context-pruning.ts` with collapsed `outdated` status.
4. Move/refactor mutation handling into `search/mutation-memory.ts` and rename reread concepts to auto-read.
5. Add `read.ts` wrapper around Pi built-in read with evidence and marker suffix.
6. Add `path-utils.ts` local to search.
7. Add `ripgrep.ts` local to search.
8. Add `grep.ts` with parser/formatter/evidence/renderer.
9. Add `ls.ts` with inventory, renderer, and startup workspace map.
10. Add `find.ts` with `rg --files` discovery.
11. Add `forget.ts` with disposition handling.
12. Add `index.ts` wiring, settings, active-tool management, one-time startup map, message renderers, and conditional memory handlers.
13. Add `README.md`.
14. Move/update tests into `test/extensions/search/`.
15. Delete `src/extensions/working-memory/` and stale tests/imports.
16. Add `docs/evals/search-tools.md`.

## Risks and mitigations

- Duplicate tool registration: delete old `working-memory/index.ts` after search registers tools.
- Built-in read visual drift: delegate to Pi built-in read renderers instead of copying read UI.
- Evidence/pruning drift: tools emit `searchEvidence`; pruning consumes metadata, not output text.
- Context bloat: hard caps in ripgrep capture, compact formatters, per-query fairness, per-source caps, and startup map byte budget.
- Ignored dependency search: defaults omit ignored/noise paths, but `grep --no-ignore`/`-u`, `find noIgnore`, and `ls all` allow narrow opt-in.
- `rg` missing: report clear errors from `grep` and `find`; do not pretend no matches.
- Path helper overgeneralization: keep helpers local to search until another extension has a real same-semantics need.

## Non-goals

- No debug telemetry slash command.
- No debug telemetry tool.
- No POSIX `find` grammar.
- No recurring workspace map injection.
- No settings outside `src/extensions/search/settings.ts`.
- No manual edits to generated tau schema.
