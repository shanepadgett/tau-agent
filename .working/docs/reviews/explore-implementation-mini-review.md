# Explore implementation mini review

Rok sees mostly solid work.

Good:

- `src/extensions/explore` is split cleanly by tool.
- `result.ts` keeps human vs agent text separate.
- `find.ts` / `grep.ts` do real filtering, budgeting, and path safety.

Watch:

- `src/extensions/explore/read.ts` is odd. It builds `createReadToolDefinition(process.cwd())`, then rebuilds again with `ctx.cwd`. That smells like stale-cwd bug and wasted work.
- `src/extensions/explore/traverse.ts` ignore handling is simple, maybe not full gitignore semantics.
- `grep.ts` runs ripgrep twice. Expected for counts + selected matches, but cost is there.

Overall: decent shape, no obvious bloat. Biggest suspicious bit is `read.ts`.
