# Read Tool Line Numbers Plan

## Goal

Add an optional `lineNumbers` flag to Tau's `read` tool so agents can ask for cited output without using ad hoc shell scripts.

## Scope

- Public tool input change: `read({ path, offset?, limit?, lineNumbers?: boolean })`.
- Default output stays unchanged.
- Line numbers apply only when `lineNumbers: true`.
- Text reads only. Image reads stay unchanged.

## Files

- `src/extensions/explore/read.ts`
- `test/extensions/explore/read.test.ts`

## Repo Facts

- Tau wraps Pi's `createReadToolDefinition()` in `src/extensions/explore/read.ts`.
- Current wrapper normalizes `@` paths and `limit`, then delegates execution to Pi's read tool.
- Pi's read input currently has `path`, `offset`, and `limit` only.
- Existing read tests cover plain text, offsets, continuation notices, truncation, errors, absolute paths, and rendering.

## Steps

1. Extend the Tau read tool schema with optional `lineNumbers: boolean`.
2. Keep delegating file resolution, image handling, truncation, and errors to Pi's read implementation.
3. After Pi returns a result, if `lineNumbers` is true and the result is a single text item, prefix content lines with 1-indexed file line numbers.
4. Start numbering at `params.offset ?? 1`.
5. Leave trailing continuation notices unnumbered when the read output ends with a blank line plus bracketed notice.
6. Update render-call text to show when line numbers were requested.
7. Add tests for default unchanged output, full-file line numbering, offset line numbering, and continuation notice preservation.

## Edge Cases

- `lineNumbers` undefined or false preserves existing output exactly.
- Empty lines still get a visible line number.
- Image reads are not line-numbered.
- Error messages are not line-numbered.
- Truncation/continuation hints remain usable and are not mistaken for file content.

## Done

- `read` exposes `lineNumbers?: boolean` in its tool schema.
- Agents can request line-numbered file output without shelling out.
- Existing read behavior stays unchanged unless the flag is set.
