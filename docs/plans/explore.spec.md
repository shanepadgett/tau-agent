# Explore Spec

## Common

- The system shall provide a first-party extension named `explore`.
- When Tau loads first-party extensions, the system shall register `ls`, `find`, `grep`, and `read` from `explore`.
- When Tau loads first-party extensions, the system shall retire the previous `search` extension surface.
- The system shall use repository-relative paths for paths inside the working directory.
- The system shall use absolute paths for paths outside the working directory.
- The system shall render displayed paths with `/` separators.
- When a path or glob argument starts with one leading `@`, the system shall ignore that leading `@` before resolving or matching it.
- The system shall allow related exploration work to be batched into one tool call.
- The system shall treat `.git`, `node_modules`, `dist`, `build`, `coverage`, `.cache`, `.next`, `.turbo`, `.parcel-cache`, and `out` as noise paths for default directory and path discovery.
- The system shall omit routine stats and metadata footer lines from `ls`, `find`, and `grep` results.
- When an explore tool call initially renders, the system shall show the tool name and concise argument summary.
- When an explore tool call initially renders, the system shall show no result body.
- When an explore tool call is collapsed after a successful result, the system shall render the command/title row and no result body.
- When an explore tool call is collapsed after an error result, the system shall render the command/title row and no error body.
- When an explore tool call is expanded after a successful result, the system shall render the command/title row followed by the human-readable result body.
- When an explore tool call is expanded after an error result, the system shall render the command/title row followed by the error body.
- When an explore result omits entries, files, or matches due to a limit, the system shall include an omission notice in the result body and model-facing content.
- When an explore result has no matches or no entries, the system shall report the empty result plainly.
- When a numeric depth, max-depth, context, or limit argument is fractional, the system shall use its integer floor.
- When a depth, max-depth, or context argument is less than 0, the system shall use 0.
- When a count limit argument is less than 1, the system shall use 1.
- When an explore tool's human-readable result differs from the model-facing content, the system shall send the model-facing content as the tool result content.
- When an explore tool's human-readable result differs from the model-facing content, the approved preview surface shall show the exact model-facing content in an `Agent Payload` section.
- When the approved preview surface displays an explore tool, the system shall show `Agent Payload`, `Initial Call`, `Collapsed Result`, `Expanded Result`, and `Pruned Result` states.
- When the approved preview surface displays headings, the system shall render the page title in bold default color, sample titles in accent, and block titles in bold default color.

## LS

- The `ls` tool shall accept `paths?`, `depth?`, `limit?`, `all?`, and `long?` arguments.
- When `paths` is omitted or empty, `ls` shall list `.`.
- When `depth` is omitted, `ls` shall list one child level below each requested directory.
- When `limit` is omitted, `ls` shall use a default result limit of 100 entries.
- When multiple paths are requested, `ls` shall divide the result budget across requested roots so each root can contribute output.
- When a requested path resolves to a directory, `ls` shall include that directory and entries within the requested depth.
- When a requested path resolves to a file, `ls` shall include that file as a single entry.
- When `all` is omitted or false, `ls` shall omit hidden paths, noise paths, and gitignored paths.
- When `all` is true, `ls` shall include hidden paths, noise paths, and gitignored paths under the requested roots.
- When `long` is true, `ls` shall include file size and modified time in the human-readable result.
- When `long` is true, `ls` shall include compact size and modified time metadata next to entries in the model-facing content.
- When `ls` initially renders, the system shall show `ls`, requested paths, effective depth, effective limit, and enabled flags.
- When `ls` renders an expanded result, the system shall show a readable tree grouped by requested root and directory.
- When `ls` renders entries within a directory, the system shall list directories before files and then sort names alphabetically.
- When `ls` renders a directory in the human-readable tree, the system shall show the directory with a trailing `/`.
- When `ls` renders a file in the human-readable tree, the system shall show the file basename under its containing directory.
- When `ls` renders nested entries in the human-readable tree, the system shall indent each child level by two spaces.
- When `ls` renders an empty directory, the system shall show the directory and an indented `[empty]` marker.
- When `ls` sends content to the model, the system shall use a compact path payload grouped by directory.
- When `ls` sends sibling files in the same directory to the model, the system shall collapse the sibling basenames into a comma-separated list on one line.
- When `ls` sends a nested directory group to the model, the system shall put the nested group on its own indented line under the parent group.
- When `ls` sends an empty directory to the model, the system shall represent it as `<path>/ [empty]`.
- When `ls` omits entries because the result limit is reached, the system shall include `… omitted N entries (limit L)`.
- If a requested path does not exist, `ls` shall return an error result that names the missing path.
- If a requested directory cannot be read, `ls` shall return an error result that names the unreadable path.

## Find

- The `find` tool shall accept `queries` and `limit?` arguments.
- Each `find` query shall accept `path?`, `patterns?`, `type?`, `maxDepth?`, `hidden?`, and `noIgnore?` arguments.
- When `path` is omitted in a query, `find` shall search `.`.
- When `patterns` is omitted or empty in a query, `find` shall match all paths under the query path.
- When a pattern contains `/`, `find` shall match the pattern against the relative path.
- When a pattern does not contain `/`, `find` shall match the pattern against the basename.
- When `type` is omitted or `any`, `find` shall return matching files and directories.
- When `type` is `file`, `find` shall return matching files.
- When `type` is `dir`, `find` shall return matching directories.
- When `maxDepth` is provided, `find` shall search no deeper than that many levels below the query path.
- When `hidden` is omitted or false, `find` shall omit hidden paths.
- When `hidden` is true, `find` shall include hidden paths.
- When `noIgnore` is omitted or false, `find` shall respect ignore rules.
- When `noIgnore` is true, `find` shall include ignored paths.
- When `noIgnore` is true, `find` shall include noise paths.
- When `limit` is omitted, `find` shall use a default result limit of 100 paths.
- When multiple queries are requested, `find` shall divide the result budget across queries so each query can contribute output.
- When `find` initially renders one query, the system shall show `find`, the query path, patterns, type, depth, effective limit, and enabled flags.
- When `find` initially renders multiple queries, the system shall show `find`, the query count, effective limit, and enabled flags shared by the query summaries.
- When `find` renders an expanded result for one query, the system shall show a readable tree grouped by directory.
- When `find` renders an expanded result for multiple queries, the system shall group the readable tree by query.
- When `find` renders entries within a directory, the system shall list directories before files and then sort names alphabetically.
- When `find` renders a directory in the human-readable tree, the system shall show the directory with a trailing `/`.
- When `find` renders a file in the human-readable tree, the system shall show the file basename under its containing directory.
- When `find` renders nested entries in the human-readable tree, the system shall indent each child level by two spaces.
- When `find` sends content to the model for one query, the system shall use a compact path payload grouped by directory.
- When `find` sends content to the model for multiple queries, the system shall prefix each query payload with `qN`.
- When `find` sends sibling files in the same directory to the model, the system shall collapse the sibling basenames into a comma-separated list on one line.
- When `find` sends nested directory groups to the model, the system shall put nested groups on indented lines under the parent group.
- When `find` omits paths because the result limit is reached, the system shall include `… omitted N matches (limit L)`.
- When no paths match, `find` shall report `No matches`.
- If a query path does not exist, `find` shall return an error result that names the missing query path.
- If a query cannot be executed, `find` shall return an error result that identifies the failed query.

## Grep

- The `grep` tool shall accept `queries`, `limit?`, `maxPerFile?`, `maxLineLength?`, and `contextOnly?` arguments.
- Each `grep` query shall accept `patterns`, `paths?`, `include?`, `exclude?`, `regex?`, `case?`, `word?`, `context?`, `hidden?`, and `noIgnore?` arguments.
- Each `grep` query shall require at least one pattern.
- When a `grep` query is a raw ripgrep argv array, the system shall reject it as invalid arguments.
- When `patterns` contains multiple values, `grep` shall match lines that satisfy any pattern.
- When `regex` is omitted or false, `grep` shall treat patterns as literal text.
- When `regex` is true, `grep` shall treat patterns as ripgrep regular expressions.
- When `case` is omitted or `smart`, `grep` shall use smart-case matching.
- When `case` is `sensitive`, `grep` shall use case-sensitive matching.
- When `case` is `insensitive`, `grep` shall use case-insensitive matching.
- When `word` is true, `grep` shall match whole words.
- When `paths` is omitted or empty, `grep` shall search `.`.
- When `include` is provided, `grep` shall search only paths matching at least one include glob.
- When `exclude` is provided, `grep` shall omit paths matching any exclude glob.
- When `context` is omitted, `grep` shall return matched lines without surrounding context lines.
- When `context` is provided, `grep` shall include that many lines before and after each matched line.
- When `contextOnly` is true, `grep` shall return context lines and omit matched lines.
- When `hidden` is omitted or false, `grep` shall omit hidden paths.
- When `hidden` is true, `grep` shall include hidden paths.
- When `noIgnore` is omitted or false, `grep` shall respect ignore rules.
- When `noIgnore` is true, `grep` shall include ignored paths.
- When `limit` is omitted, `grep` shall use a default result limit of 100 lines.
- When `maxPerFile` is omitted, `grep` shall show at most 8 lines per file per query.
- When `maxLineLength` is omitted, `grep` shall show at most 200 characters per line.
- When `maxLineLength` is less than 20, `grep` shall use 20.
- When multiple queries are requested, `grep` shall divide the result budget across queries so each query can contribute output.
- When `grep` initially renders one query, the system shall show `grep`, patterns, paths, include/exclude globs, context, effective limits, and enabled flags.
- When `grep` initially renders multiple queries, the system shall show `grep`, the query count, effective limits, and enabled flags shared by the query summaries.
- When `grep` renders an expanded result for one query, the system shall group matching lines by file.
- When `grep` renders an expanded result for multiple queries, the system shall group matching lines by query and file.
- When `grep` sends content to the model, the system shall send the same grouped match result used by the expanded human-readable result.
- When `grep` groups matches by file, the system shall sort file groups by displayed path.
- When `grep` renders lines within a file group, the system shall sort lines by line number.
- When `grep` renders a file group, the system shall show the file path and line count when the line count is available.
- When `grep` renders a matched line, the system shall show `line: text`.
- When `grep` renders a context line, the system shall show `line- text`.
- When a matched line exceeds `maxLineLength`, `grep` shall truncate the displayed line around the first match.
- When a context line exceeds `maxLineLength`, `grep` shall truncate the displayed line without hiding its line number.
- When `grep` omits matches because the result limit is reached, the system shall include `… omitted N matches (limit L)`.
- When `grep` omits matches in a file because `maxPerFile` is reached, the system shall include `… omitted N matches in file (maxPerFile M)`.
- When no lines match, `grep` shall report `No matches`.
- If a regex pattern is invalid, `grep` shall return an error result with the regex error.
- If a searched path does not exist, `grep` shall return an error result that names the missing path.
- If the underlying content search fails, `grep` shall return an error result with the search error.

## Read

- The `read` tool shall accept `path`, `offset?`, and `limit?` arguments.
- The `read` tool shall accept relative and absolute paths.
- The `read` tool shall treat `offset` as a 1-indexed line number.
- The `read` tool shall treat `limit` as a maximum number of lines to read.
- When `offset` is omitted, `read` shall start at line 1.
- When `limit` is omitted, `read` shall read until the built-in line or byte truncation limit is reached.
- When `read` initially renders, the system shall show `read`, the target path, and the requested line range when `offset` or `limit` is present.
- When `limit` is provided and unread lines remain, `read` shall include `[N more lines in file. Use offset=M to continue.]`.
- When line-count truncation occurs, `read` shall include `[Showing lines S-E of T. Use offset=M to continue.]`.
- When byte truncation occurs, `read` shall include `[Showing lines S-E of T (B limit). Use offset=M to continue.]`.
- When a first line exceeds the byte limit, `read` shall include the built-in first-line overflow notice.
- When `read` renders an expanded text result, the system shall preserve built-in continuation and truncation wording.
- When `read` sends text content to the model, the system shall send the built-in read content.
- When `read` targets a supported image, the system shall send the built-in image content and text note.
- When the current model does not support images, `read` shall include the built-in non-vision image note.
- If `offset` is beyond the end of the file, `read` shall return an error result.
- If `path` does not exist, `read` shall return an error result.
- If `path` resolves to a directory, `read` shall return an error result.
- If `path` cannot be read, `read` shall return an error result.

## Shared Row State

- The system shall provide shared row-state behavior for participating custom tool rows.
- The system shall allow participating custom tool rows to be marked by tool call id after execution.
- When a participating tool row has no visual state, the system shall render the command/title in the normal tool title color.
- When a participating tool row has the `pruned` visual state, the system shall render the command/title in the warning color.
- When a participating tool row has a visual state, the system shall not add a visible status word to the row.
- When a participating tool row changes visual state after execution, the system shall preserve the historical tool result content.
- When a participating tool row changes visual state after execution, the system shall preserve the historical model-facing tool result content.
- When a participating tool row changes visual state after execution, the system shall change only row styling.
