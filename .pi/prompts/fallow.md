---
description: Run intentional Fallow analysis beyond automatic silent checks
argument-hint: "[audit|health|inspect|trace|list|fix|explain|production|full] [args]"
---

Fallow workflow: ${ARGUMENTS:-audit}

Automatic silent checks already cover `mise run fallow:dead-code` and `mise run fallow:dupes` after matching TS edits. Do not re-run those unless diagnosing a silent failure. This prompt is for intentional Fallow work that is not part of the post-edit gate.

Defaults: compact + quiet via mise `FALLOW_FORMAT` / `FALLOW_QUIET`. Prefer `mise run <task>`. Use `fallow … --format json --quiet` only when you need structured `actions[]` or traces. Use `mise run fallow:human` for interactive reading.

## Mode

Parse `$ARGUMENTS` first token as mode (default `audit`). Remainder is mode args.

| Mode | When | Command |
| --- | --- | --- |
| `audit` | Before claiming done, commit, or PR | `mise run fallow:audit` (optional `-- --base <ref>`) |
| `health` | Prioritize refactors; complexity/hotspots | `mise run fallow:health` |
| `inspect` | Evidence bundle for one file/symbol | `fallow inspect --file <path>` or `--symbol <file>:<export>` |
| `trace` | Prove unused before delete | `fallow dead-code --trace <file>:<export>` or `--trace-dependency <name>` or `fallow dupes --trace dup:<fp>` |
| `list` | Sanity-check entries/plugins/workspaces | `mise run fallow:list` |
| `fix` | Safe auto-remove unused exports/deps | `fallow fix --dry-run` then ask user; only then `fallow fix --yes` |
| `explain` | Understand one issue type | `fallow explain <issue-type>` |
| `production` | Production-only dead-code (no tests/dev) | `fallow dead-code --production` |
| `full` | Full dead-code + dupes + health once | `mise run fallow` |

Unknown mode → treat whole args as free-form `fallow` CLI after showing the table once.

## Rules

1. Never delete an "unused" export/file/dep without `trace` (or type-aware impact) on that symbol.
2. Never run `fallow watch`.
3. Prefer fix-in-code over config. Exception order: model in config (`entry` / `framework` / `dynamicallyLoaded`) → `@expected-unused` → `// fallow-ignore-next-line <rule> -- reason` → broad ignore last.
4. Staged unreachable code for a later wiring task: `// fallow-ignore-file unused-file -- wired by <task/name>` (see AGENTS.md). Remove in the wiring task.
5. Do not widen architecture/config ignores to silence real debt without user OK.
6. After fixes that touch TS, end the turn so silent `fallow:dead-code` / `fallow:dupes` re-run. Do not manually re-run them unless the silent failure output is incomplete.
7. Report: command(s) run, exit meaning (0 clean / 1 findings / 2 runtime error), decisive findings only. No wall of logs.

## Config

- Policy: `.fallowrc.jsonc`
- Tasks: `mise tasks` (`fallow`, `fallow:*`)
- Cache dir `.fallow/` is gitignored
