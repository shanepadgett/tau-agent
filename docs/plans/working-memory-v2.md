# Working Memory V2

## Goal

Expand working-memory after V1 is working and measured. Keep the raw session append-only and continue deriving outbound model context from the branch.

## Scope candidates

### Multi-range focused read

Add a tool that reads several ranges from one file in one call:

```ts
focus_read({
	path: "src/foo.ts",
	ranges: [
		{ offset: 40, limit: 30 },
		{ offset: 180, limit: 50 },
	],
	supersedes: "previous_reads",
})
```

Purpose:

- reduce multiple tool-call/result wrappers
- make retained evidence explicit
- give read superseding a stronger contract than guessing from ordinary `read`

### Assistant discussion checkpoints

Add explicit checkpoints for planning/discussion bloat:

```text
Working memory checkpoint:
- user requirement: /tree before cleanup restores raw context
- decision: context hook stubs tool results only
- open question: exact grep parser shape
```

Only prune assistant prose after a checkpoint exists. Do not prune assistant messages by default.

### Check-output superseding

Stub stale check outputs when a later equivalent check supersedes them:

```text
bash npm test
=> failed

patch ...

bash npm test
=> passed

later context:
bash npm test
=> [working-memory: stale failed check forgotten; later equivalent check passed. Re-run if needed.]
```

Keep failed checks if no later passing equivalent exists.

### Wider exploration pruning

Consider deterministic `find`/`ls` pruning only when a later code map or focused evidence makes the listing redundant.

Do not prune directory shape by default.

## Non-goals

- No budget/cache TTL policy.
- No provider keepalive behavior.
- No raw session mutation.
- No automatic semantic summarization without an explicit checkpoint.

## Entry criteria

- V1 works under `/tree` navigation.
- V1 stubs only intended tool results.
- V1 produces measurable context reduction on real sessions.
- Failure modes are understood from manual smoke tests or session replay.

## Files/ranges to reread if needed

- `docs/plans/working-memory-v1.md`: current V1 behavior and constraints.
- `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` lines 1290-1335 and 1732-1832: custom tool registration.
- `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/session-format.md` lines 43-110: assistant and tool result message shapes.
