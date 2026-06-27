# Custom file tools spec

## Public surface

- The custom file tools feature shall expose public tools named `grep`, `find`, and `ls`.
- Where custom file tools override built-in tools, the custom file tools feature shall define explicit prompt snippets and prompt guidelines for those tools.
- Where custom file tool prompt guidelines are defined, each guideline shall name the tool it describes.
- Where custom file tools accept paths, the custom file tools feature shall normalize a leading `@` before resolving the path.

## Shared agent guidance

- The `grep`, `find`, and `ls` prompt guidance shall instruct the agent to batch related requests in one tool call when practical.
- The `grep`, `find`, and `ls` prompt guidance shall instruct the agent to use tool parameters instead of `bash` pipelines for ordinary search, path discovery, and directory inventory shaping.
- The `grep`, `find`, and `ls` prompt guidance shall instruct the agent to use `grep` for file-content discovery, `find` for filename or path discovery, and `ls` for directory inventory.
- When the agent opts into ignored, hidden, or noise paths, the `grep`, `find`, and `ls` prompt guidance shall instruct the agent to use narrow paths, patterns, or globs.

## Shared output behavior

- The `grep`, `find`, and `ls` tools shall preserve exact paths in tool output.
- When a `grep`, `find`, or `ls` call contains multiple batched work items, the tool shall cap output fairly per work item so one work item cannot starve another work item.
- When compact `grep`, `find`, or `ls` output exceeds configured caps, the tool shall report shown and omitted counts.
- When compact `grep`, `find`, or `ls` output contains many results from one file, directory, or path, the tool shall cap that source so one source cannot drown other sources.

## Search scope

- The `grep` and `find` tools shall respect `.gitignore` by default.
- The `find` and `ls` tools shall omit hidden or noise paths by default.
- When a `grep`, `find`, or `ls` call explicitly opts into ignored, hidden, or noise paths, the tool shall include those paths for that call.

## `grep`

- The `grep` tool shall use `rg` as its search engine.
- The `grep` tool shall accept batched rg-style queries.
- The `grep` tool shall accept compact-output controls for total result limit, per-file result limit, maximum line length, and context-only output.
- When related content searches share paths and flags, the `grep` prompt guidance shall instruct the agent to combine search terms in one query with multiple `-e` patterns.
- When related content searches need different paths or flags, the `grep` prompt guidance shall instruct the agent to combine those searches in one tool call with multiple queries.
- When the `grep` tool returns normal match output, the `grep` tool shall group matches by file and preserve each match line number.
- When the `grep` tool truncates a long matching line, the `grep` tool shall preserve text around the match and mark omitted text with an ellipsis.
- When a `grep` query requests an already compact or non-match output mode, the `grep` tool shall return native-compatible rg output instead of grouped compact match output.
- If compact `grep` output would be larger or less useful than native-compatible output, then the `grep` tool shall return native-compatible output.
- If `rg` fails for a reason other than no matches, then the `grep` tool shall report the failure clearly.
- When the `grep` tool returns match output, the working-memory integration shall preserve prunable navigation evidence and matched-file line-count footer behavior.

## `find`

- The `find` tool shall use agent-native structured parameters instead of shell-style POSIX `find` arguments.
- The `find` tool shall accept batched path-discovery queries.
- Each `find` query shall support a search path, filename glob patterns, result type, maximum depth, ignored-file opt-in, and hidden-file opt-in.
- The `find` tool shall treat multiple filename glob patterns in one query as alternatives.
- The `find` tool shall default to the current working directory, any result type, gitignore-respecting search, and hidden-file omission.
- When the `find` tool returns path results, the `find` tool shall group paths by directory.
- When the `find` tool returns path results, the `find` tool shall include compact directory counts and extension summaries where useful.

## `ls`

- The `ls` tool shall provide token-efficient directory inventory.
- The `ls` tool shall accept batched paths.
- The `ls` tool shall support recursive depth, output limit, hidden-or-noise opt-in, and long-output opt-in.
- The `ls` tool shall default to the current working directory, depth one, compact output, and hidden-or-noise omission.
- When the `ls` tool returns directory inventory, the `ls` tool shall group directories and files compactly.
- When the `ls` tool returns compact output, the `ls` tool shall omit owner, group, and date columns.
- When the `ls` tool returns long output, the `ls` tool shall include compact metadata without abandoning output caps.
- When the `ls` tool omits hidden or noise entries, the `ls` tool shall summarize those omissions.

## Startup workspace map

- When the first agent run in a session begins, the custom file tools feature shall provide one compact startup workspace map to the agent context.
- When the startup workspace map has already been provided for a session, the custom file tools feature shall not provide another automatic workspace map during later turns.
- When a session is compacted, the custom file tools feature shall not automatically provide another workspace map after compaction.
- When the agent needs directory structure after the startup workspace map, the `ls` prompt guidance shall instruct the agent to call `ls`.
- The startup workspace map shall use the same compact inventory formatter as the `ls` tool.
- The startup workspace map shall respect `.gitignore`, omit hidden or noise directories by default, use directory depth three from the repository root, keep files mostly to root-level and configuration-level entries, enforce a hard output budget around four kilobytes, and report compact omitted counts.

## Agent evaluation scaffold

- The project shall include a markdown agent evaluation scaffold for the custom file tools.
- The agent evaluation scaffold shall not be wired into normal automated checks.
- The agent evaluation scaffold shall instruct an agent to perform deep repository investigation using `grep`, `find`, `ls`, and `read` except where explicitly allowed.
- The agent evaluation scaffold shall test whether the agent batches content searches, path discovery, and directory inventory requests.
- The agent evaluation scaffold shall include fixture instructions or fixture files that cover ignored paths, noisy directories, long lines, repeated matches, and multiple plausible search terms.
- The agent evaluation scaffold shall define a compact manual feedback log format for tool name, argument summary, success or failure, output size, truncation or omission details, and call counts.
