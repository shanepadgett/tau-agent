# Custom file tools working notes

Purpose: compacted planning handoff for Tau custom `grep`, `find`, and `ls` tools. After chat compaction, reread only the references below unless contradicted or insufficient.

Current rough shape, not approved spec:
- Approved scope for spec: override built-in tool names `grep`, `find`, `ls`; add one automatic startup workspace map; add markdown agent eval scaffold.
- Out of scope for this spec: debug telemetry slash command or debug telemetry tool.
- `grep` rough preference: `rg`-backed, batched argv-like queries, plus compact-output knobs such as `limit`, `maxPerFile`, `maxLineLength`, `contextOnly`.
- Preserve working-memory behavior around grep evidence, loc footer, renderer, and pruning.

`grep` discussion notes:
- Goal: help the agent search more with fewer tool calls.
- Prefer schema shape like `{ queries: string[][], limit, maxPerFile, maxLineLength, contextOnly }`.
- Each `queries[]` entry is one rg-style argv. Use one entry with multiple `-e` patterns when paths/flags match. Use multiple entries in one tool call when paths/flags differ.
- Tool definition guidance should strongly encourage batching related search ideas in one `grep` call.
- Tool definition guidance should discourage `bash rg | head | awk | cut`; use `limit`, `maxPerFile`, `maxLineLength`, paths, globs, and multi-query batching instead.
- Use `find` for filename discovery. Use `grep` for file contents.
- Compact mode should avoid blind truncation. Prefer parsing `rg --json` internally so match spans are known.
- Output should always preserve file path and line number, center long-line truncation around the match, and mark omissions with `…`.
- Caps should be fair: cap per query so one query cannot starve another, and cap per file so one noisy file cannot drown signal.
- Output should include terse summaries such as `[query 2: 40 shown, 93 omitted, 7 files]`.
- Match RTK token-saving behavior where useful: grouped output, caps, line truncation, omitted summaries, native passthrough for already-compact modes, and fallback to native/plain output when compact output would be larger or less useful.
- Deliberate difference from RTK: preserve exact paths instead of compacting paths when path compaction could hurt later `read` calls.
- Default search should respect `.gitignore` to avoid `node_modules`, build output, caches, and vendored trash.
- Ignored paths must remain searchable by explicit opt-in, e.g. `--no-ignore` or `-u`, with narrow paths/globs such as `node_modules/@earendil-works/pi-coding-agent` and `--glob "*.d.ts"`.

`find` discussion notes:
- Goal: agent-native structured path discovery with RTK-style token-efficient output.
- Start structured only, not shell/POSIX `find` args. If agent evals show struggle, reconsider schema.
- Prefer schema shape like `{ queries: [{ path, patterns, type, maxDepth, noIgnore, hidden }], limit }`.
- `patterns` are filename globs by default. Multiple patterns in one query are ORed. Multiple queries in one tool call cover different paths/types/depths.
- Defaults: `path: "."`, `type: "any"`, respects `.gitignore`, hidden false.
- Tool definition guidance should strongly encourage batching filename/path ideas in one `find` call.
- Tool definition guidance should discourage `bash find | head | sed`; use `queries`, `patterns`, `type`, `maxDepth`, and `limit` instead.
- Output should group by directory, preserve exact relative paths, cap fairly per query, and include terse totals such as shown/omitted paths, directory count, and extension summary.
- Ignored paths must remain searchable by explicit opt-in, e.g. `noIgnore: true`, only with narrow paths/globs.

Agent evaluation notes:
- Add markdown eval scaffolding, not an automated test wired into normal checks.
- Eval should give an agent a deep repository-investigation task and require use of only `grep`, `find`, `ls`, and `read` except where explicitly allowed.
- Eval should cover each custom tool and verify whether the agent batches searches/listing/discovery instead of issuing many narrow calls.
- Eval should include a small fixture or fixture instructions with enough files, ignored paths, noisy dirs, long lines, repeated matches, and multiple plausible search terms.
- Add a token-efficient feedback artifact so a human can review tool-use quality after an eval run: tool name, args summary, pass/fail/error, output size/truncation/omission details, and counts of calls.
- Possible public surface under discussion: a debug slash command or tool that exports recent tool-call telemetry to a compact log. Needs explicit approval before implementation.

`ls` discussion notes:
- Goal: RTK-like token-efficient directory inventory, plus one automatic startup workspace map.
- Expose an `ls` tool so the agent can request fresh/deeper structure when it needs it.
- Also inject a compact workspace map once at session start or first agent run only. Do not reinject every turn. Do not reinject after compaction. After compaction, the agent has agency to call `ls` if it needs structure again.
- Automatic workspace map is context data, not a prompt-guideline bullet. Keep prompt guidelines for instructions on how to use `ls`.
- Automatic workspace map should respect `.gitignore` and omit noise dirs by default.
- Automatic workspace map should use the same inventory formatter as `ls`: compact tree/inventory, dirs/files grouped, counts, omitted summaries, exact paths, no owner/group/date columns unless long output is explicitly requested by the tool.
- Initial workspace map depth should be shallow and capped. Current recommendation: directory depth 3 from repo root, files mostly root/config-level, hard output budget around 4 KB, with per-directory caps and omitted summaries.
- `ls` tool rough schema: `{ paths: string[], depth, limit, all, long }`.
- Defaults: `paths: ["."]`, `depth: 1`, compact output, hidden/noise omitted.
- Tool should batch related directories in one call and cap per directory so one giant directory does not drown output.
- Explicit ignored/noise targets should remain listable, e.g. `paths: ["node_modules/@earendil-works/pi-coding-agent"], all: true`, with narrow paths.

Repo references to reread:
- `package.json:11-17` — Pi extension auto-loads `./src/extensions/*/index.ts`.
- `src/extensions/working-memory/index.ts:1-46` — working-memory registers tools, renderers, and pruning state.
- `src/extensions/working-memory/agent-surface.ts:1-56` — current read/grep imports and grep schema.
- `src/extensions/working-memory/agent-surface.ts:78-118` — current `read` and `grep` registration; grep wraps pi built-in grep and custom renderer.
- `src/extensions/working-memory/agent-surface.ts:158-209` — grep `[loc: path:lineCount]` footer and output-path normalization.
- `src/extensions/working-memory/renderers.ts:73-99` — current grep call renderer expects structured grep args.
- `src/extensions/working-memory/context-pruning.ts:56-62` — grep evidence state collections.
- `src/extensions/working-memory/context-pruning.ts:101-120` — grep results become prunable/superseded evidence.
- `src/extensions/working-memory/context-pruning.ts:226-244` — grep evidence extraction from tool output.
- `src/extensions/working-memory/context-pruning.ts:321-334` — grep output path parsing assumptions.
- `src/extensions/soul/index.ts:20-33` — soul captures runtime context on session start and builds the Rok system prompt before agent start.
- `src/extensions/soul/prompt.ts:63-74` — Rok prompt assembly includes tool snippets and prompt guidelines.
- `src/extensions/soul/prompt.ts:101-121` — tool snippet and guideline formatting.
- `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/grep.d.ts:1-30` — built-in grep schema/details/ops.
- `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/find.d.ts:1-27` — built-in find schema/details/ops.
- `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/ls.d.ts:1-29` — built-in ls schema/details/ops.
- `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:497-532` — `before_agent_start` can add message or modify system prompt and exposes `systemPromptOptions`.
- `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:1290-1314` — custom tools use `promptSnippet` and `promptGuidelines`.
- `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:1734-1742` — prompt guidelines are flat bullets and each should name the tool.
- `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:1915-1915` — overrides do not inherit built-in prompt metadata.

RTK references to reread:
- `/Users/shanepadgett/.local/share/tau-agent/references/rtk/README.md:37-57` — savings claim table.
- `/Users/shanepadgett/.local/share/tau-agent/references/rtk/README.md:123-142` — built-in tools bypass hook; savings mechanisms: filtering, grouping, truncation, dedup.
- `/Users/shanepadgett/.local/share/tau-agent/references/rtk/README.md:147-152` — file command examples.
- `/Users/shanepadgett/.local/share/tau-agent/references/rtk/src/cmds/system/search.rs:1-7` — shared grep/rg compression intent.
- `/Users/shanepadgett/.local/share/tau-agent/references/rtk/src/cmds/system/search.rs:22-58` — rg/grep value-taking flag tables.
- `/Users/shanepadgett/.local/share/tau-agent/references/rtk/src/cmds/system/search.rs:140-229` — arg extraction for patterns, paths, flags.
- `/Users/shanepadgett/.local/share/tau-agent/references/rtk/src/cmds/system/search.rs:265-306` — grep vs rg engine flags and NUL-separated parse aid.
- `/Users/shanepadgett/.local/share/tau-agent/references/rtk/src/cmds/system/search.rs:342-405` — run flow and passthrough for uncompactable shapes.
- `/Users/shanepadgett/.local/share/tau-agent/references/rtk/src/cmds/system/search.rs:417-556` — grouping, capping, faithful-baseline fallback.
- `/Users/shanepadgett/.local/share/tau-agent/references/rtk/src/cmds/system/search.rs:580-626` — robust match-line parser and format-flag passthrough list.
- `/Users/shanepadgett/.local/share/tau-agent/references/rtk/src/cmds/system/search.rs:629-687` — match-centered line cleanup and path compaction.
- `/Users/shanepadgett/.local/share/tau-agent/references/rtk/tests/grep_context_test.rs:1-74` — context lines and no NUL leakage regressions.
- `/Users/shanepadgett/.local/share/tau-agent/references/rtk/tests/grep_faithful_format_test.rs:1-159` — grep fidelity edge cases: colons, anchors, regex, stdin, context.
- `/Users/shanepadgett/.local/share/tau-agent/references/rtk/src/cmds/system/find_cmd.rs:31-63` — find args/defaults.
- `/Users/shanepadgett/.local/share/tau-agent/references/rtk/src/cmds/system/find_cmd.rs:68-98` — supported/unsupported native find dispatch.
- `/Users/shanepadgett/.local/share/tau-agent/references/rtk/src/cmds/system/find_cmd.rs:102-178` — native and RTK find arg parsers.
- `/Users/shanepadgett/.local/share/tau-agent/references/rtk/src/cmds/system/find_cmd.rs:194-236` — ignore-aware walk and match behavior.
- `/Users/shanepadgett/.local/share/tau-agent/references/rtk/src/cmds/system/find_cmd.rs:291-362` — directory grouping, result limiting, extension summary.
- `/Users/shanepadgett/.local/share/tau-agent/references/rtk/src/cmds/system/ls.rs:22-71` — ls arg handling and long/all detection.
- `/Users/shanepadgett/.local/share/tau-agent/references/rtk/src/cmds/system/ls.rs:90-111` — compact/fallback output path.
- `/Users/shanepadgett/.local/share/tau-agent/references/rtk/src/cmds/system/ls.rs:230-314` — compact ls output shape, noise filtering, summary.
