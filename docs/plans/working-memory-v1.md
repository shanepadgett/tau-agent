# Working Memory V1

## Goal

Maintain a compact, branch-aware outbound model context by stubbing deterministic stale tool evidence while preserving raw session history.

Session history is append-only. The model context is a derived working set built in the Pi `context` hook.

## Product model

This is a pseudo sample only, not how tool calls actually look.

```text
grep "FooConfig" src
=> src/a.ts:12 ...
=> src/b.ts:44 ...

read src/a.ts offset=1 limit=120
=> broad evidence

read src/a.ts offset=40 limit=30
=> focused evidence

read src/b.ts offset=35 limit=40
=> focused evidence

patch src/a.ts
=> mutation result kept

read src/a.ts offset=40 limit=35
=> post-mutation evidence

forget keep="FooConfig lives in src/a.ts and src/b.ts. src/a.ts was patched; current relevant range is 40-74."
=> retained checkpoint kept
```

Later outbound context:

```text
grep "FooConfig" src
=> [working-memory: stale grep result forgotten; matched files were read afterward. Re-run if needed.]

read src/a.ts offset=1 limit=120
=> [working-memory: stale read forgotten; superseded by focused read lines 40-69. Re-read if needed.]

read src/a.ts offset=40 limit=30
=> [working-memory: stale read forgotten; file changed afterward. Re-read before relying on old contents.]

read src/b.ts offset=35 limit=40
=> focused evidence kept

patch src/a.ts
=> mutation result kept

read src/a.ts offset=40 limit=35
=> post-mutation evidence kept

forget
=> retained checkpoint kept
```

## Scope

- Add `src/extensions/working-memory/index.ts`.
- Add `src/extensions/working-memory/README.md`.
- Register a `forget` tool for explicit checkpoints.
- Use the Pi `context` hook to stub stale tool results in future model context.
- Preserve raw session JSONL and `/tree` behavior.
- Auto-stub deterministic stale evidence:
  - broad `read` superseded by narrower same-path reads
  - stale `read` results for files changed later in the branch
  - complete `grep` results whose matched files were all read afterward
- Keep mutation results, failed tool results, user messages, and assistant messages unchanged.

No settings, no persistent store, no shared module, no read-tool override, no cache policy.

## Out of scope

- Budget/cost/cache TTL decisions.
- Code map.
- Assistant-message pruning or carry-forward protocol.
- Automatic `ls`, `find`, or `bash` pruning.
- Compaction replacement.
- Multi-range read tool.

## Branch and `/tree` behavior

- Derive pruning from `event.messages` each time.
- Do not use module-level forgotten IDs.
- Navigating before a `forget`, focused read, grep replacement, or mutation removes that event from the branch and therefore removes its pruning effect.
- After Pi compaction, normal compaction behavior applies.

## `forget` tool

Schema:

```ts
{
	keep: string;
	mode?: "superseded_reads" | "safe_exploration" | "paths";
	paths?: string[];
}
```

Semantics:

- `keep` is the retained working-memory checkpoint.
- `superseded_reads` stubs only reads already superseded by narrower reads. Default.
- `safe_exploration` stubs successful prior `read` and `grep` results in the current task when `keep` contains the facts still needed.
- `paths` stubs successful prior `read` and eligible `grep` results for listed paths.

Tool result:

```ts
{
	content: [{ type: "text", text: `Working memory retained:\n${keep}` }],
	details: {
		workingMemory: { version: 1, mode, paths },
	},
}
```

## Deterministic pruning rules

### Reads

Stub an earlier `read` when all are true:

- same normalized path
- same file epoch
- earlier displayed range contains the later displayed range
- later range is smaller
- both results are successful text results
- no unknown range/content shape

Range rules:

- `offset` missing means line 1.
- `limit` missing means open-ended, bounded by truncation details when present.
- `details.truncation.outputLines` bounds displayed lines for truncated reads.
- Invalid/non-integer/zero/negative `offset` or `limit` means skip pruning for that read.
- Image or mixed-content reads are kept.

### Grep

Stub an earlier `grep` when all are true:

- grep result is successful text
- grep result is not truncated and did not hit a match limit
- matched file set can be parsed safely from the result text
- every matched file has a later successful read in the same current-task segment
- no matching file was mutated between grep and read without a later post-mutation read

If any part is unclear, keep the grep result.

### Mutations

Known mutation tools create a new file epoch:

- built-in `write`
- built-in `edit`
- Tau `patch`

Mutation results are always kept.

Reads from earlier epochs are stale. If they appear in future context, replace their content with a warning stub instead of old file contents.

## Path handling

Use a local helper backed by Node:

```ts
import { resolve } from "node:path";

function normalizeReadPath(cwd: string, path: unknown): string | undefined {
	if (typeof path !== "string") return undefined;
	const cleaned = path.trim().replace(/^@/, "");
	return cleaned ? resolve(cwd, cleaned) : undefined;
}
```

No `realpath`. No filesystem reads in the context hook. No shared path abstraction for one consumer.

## Implementation shape

```ts
export default function workingMemory(pi: ExtensionAPI): void {
	pi.registerTool(FORGET_TOOL);
	pi.on("context", (event, ctx) => ({ messages: pruneContext(event.messages, ctx.cwd) }));
}
```

Functions that likely earn their place:

- `normalizeReadPath(cwd, path)`
- `readRange(input, details)`
- `isNarrowerContainedRange(earlier, later)`
- `stubReadResult(read, reason)`
- `stubGrepResult(grep, reason)`

No class. No manager. No registry object. No cache.

## Safety and performance

- Pure CPU work in the `context` hook.
- One forward scan over `event.messages`.
- No `structuredClone`; Pi already clones before extension context handlers.
- Shallow-copy only changed `toolResult` messages.
- Preserve `toolCallId`, `toolName`, `details`, `isError`, and `timestamp`.
- Replace only `content`.
- Unknown shape means keep original content.
- Success means `isError === false`; do not infer from text.

## Prompt guidance

The `forget` prompt metadata should tell the agent:

- Use focused reads after broad reads to retain exact evidence.
- After grep, read the matched files that matter.
- Use `forget` after exploration when the surviving facts fit in `keep`.
- Never forget user requirements, active decisions, mutation results, failed checks, or unresolved errors.
- If unsure, keep it.

## Checks

- Typecheck.
- Manual smoke after `/reload`:
  - broad read then focused read stubs broad read
  - grep then read all matched files stubs grep
  - patch stales pre-patch reads and keeps patch result
  - `/tree` before focused read/forget restores unstubbed context

## Files/ranges to reread if needed

Pi docs/types:

- `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` lines 620-640: `context` hook.
- `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` lines 1290-1335 and 1732-1832: custom tool registration.
- `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/session-format.md` lines 43-110: content blocks and tool result messages.
- `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.d.ts`: read input/details.
- `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/grep.d.ts`: grep input/details.

Tau repo patterns:

- `package.json` lines 8-12: extension discovery.
- `src/extensions/qna/index.ts` lines 67-142 and 187-211: `defineTool`, registration, event style.
- `src/extensions/patch/executor.ts` lines 16-24 and 42-61: patch summary shape.
- `src/extensions/attention/README.md` lines 1-24: README style.
