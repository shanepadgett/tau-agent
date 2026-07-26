# Path conventions

## Inputs

- Paths may be absolute or cwd-relative.
- Leading `@` on path-like tool args is stripped as a convenience (example: `@src/foo.ts` → `src/foo.ts`).
- Path resolution failures become clear errors naming the input.

## Display

- Model-facing paths are shown relative to cwd when possible.
- Multi-root or multi-file outputs separate files clearly enough to attribute matches and graph sites.
- Prefer path factoring over repeating full paths on every row ([output-density.md](output-density.md)).

## Ignore / noise defaults (traversal)

- Default Explore traversal (structural scans, guidance discovery) respects ignore rules (gitignore-style).
- Default traversal hides hidden path segments unless the caller opts into hidden.
- Default traversal hides common noise directories/files unless the caller opts into noise/ignored inclusion.
- Harness `ls` / `find` / `grep` follow Pi ignore/hidden rules; Explore does not reimplement those tools.

## Structural scans

- Recursive structural scans (`outline` recursive, `discover`, graph scope walks, etc.) are ignore-aware.
- Recursive structural scans honor traversal budgets separate from model-visible output limits:
  - max files
  - max source bytes
  - max depth
  - max elapsed time
- Current recursive budget defaults used by structural directory ops:
  - max files: 2000
  - max source bytes: 64 MiB
  - max depth: 32
  - max elapsed: 20s
- Hitting a budget is reported as an exception/limit condition, not silent success that pretends the tree is complete.

## Cancellation

- Long-running tools honor abort/cancellation and fail clearly when cancelled.
