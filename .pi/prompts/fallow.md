---
description: Run intentional Fallow analysis beyond automatic silent checks
argument-hint: "[audit|health|inspect|trace|list|fix|explain|production|full] [args]"
---

Fallow workflow: ${ARGUMENTS:-audit}

Automatic silent checks already cover `mise run fallow:dead-code` and `mise run fallow:dupes` after matching TS edits. Do not re-run those unless diagnosing a silent failure. This prompt is for intentional Fallow work that is not part of the post-edit gate.

Defaults: compact + quiet via mise `FALLOW_FORMAT` / `FALLOW_QUIET`. Prefer `mise run <task>`. Use `fallow … --format json --quiet` only when you need structured `actions[]` or traces. Use `mise run fallow:human` for interactive reading.

## Baseline (required state)

Repo is healthy only when all of the following hold. Any miss is a regression — fix in code (or report blocker); do not paper over with config.

| Check | Required |
| --- | --- |
| Dead code / cycles / unresolved / unlisted deps | Clean (`mise run fallow:dead-code` exit 0) |
| Duplication | Clean under current `duplicates` policy (`mise run fallow:dupes` exit 0) |
| Complexity (non-language) | `fallow health --complexity` → `functions_above_threshold: 0` at defaults `maxCyclomatic: 20`, `maxCognitive: 15` |
| Full gate | `mise run fallow` exit 0 (dead-code + dupes hard-fail; health score ≥ 75) |
| Health score floor | ≥ 75 (mise `fallow` task). Prefer stay in A (≥ 90 not required) |

### Allowed policy exceptions (do not expand)

Only these `health.thresholdOverrides` in `.fallowrc.jsonc`:

1. `packages/agent/src/ast/languages/*.ts` — per-grammar decl walkers; parallel by design. Ceilings stay near need (currently 60/80); do not raise.
2. `packages/agent/src/ast/graph/relationships.ts` → `queryRelationships` only — intentional ceiling until that function is split (currently 90/250). Do not broaden to the whole file or other symbols.

`maxCrap: 10000` and `crapRefactorBand: 0` stay until real Istanbul coverage is wired via `health.coverage` / `--coverage`. Do not lower `maxCrap` without coverage (false CRAP noise). Do not treat CRAP as a refactor signal while disabled.

Language adapters under `packages/agent/src/ast/languages/*.ts` are out of complexity grind scope unless the user explicitly asks. Product / shared / extension code must stay under 20/15 with no new function ceilings.

### Regressions to reject

- New unused files, exports, deps, cycles, unresolved imports
- New dupe findings outside existing `duplicates.ignore` paths
- Any non-language function above cyclo 20 or cognitive 15
- New `thresholdOverrides`, raised ceilings, broad `ignorePatterns`, or ignore comments used to silence debt without user OK
- Full gate score dropping below 75
- Dropping or widening the two allowed overrides without an intentional code change that makes them unnecessary or still correct

When mode is `full` or `health`, verify baseline (not only print findings). If baseline fails, treat as not good and either fix or state the concrete miss.

## Mode

Parse `$ARGUMENTS` first token as mode (default `audit`). Remainder is mode args.

| Mode | When | Command |
| --- | --- | --- |
| `audit` | Before claiming done, commit, or PR | `mise run fallow:audit` (optional `-- --base <ref>`) |
| `health` | Complexity / hotspots / targets vs baseline | `mise run fallow:health` |
| `inspect` | Evidence bundle for one file/symbol | `fallow inspect --file <path>` or `--symbol <file>:<export>` |
| `trace` | Prove unused before delete | `fallow dead-code --trace <file>:<export>` or `--trace-dependency <name>` or `fallow dupes --trace dup:<fp>` |
| `list` | Sanity-check entries/plugins/workspaces | `mise run fallow:list` |
| `fix` | Safe auto-remove unused exports/deps | `fallow fix --dry-run` then ask user; only then `fallow fix --yes` |
| `explain` | Understand one issue type | `fallow explain <issue-type>` |
| `production` | Production-only dead-code (no tests/dev) | `fallow dead-code --production` |
| `full` | Full gate + baseline verify once | `mise run fallow`; on failure also run `fallow health --complexity --format json --quiet` for threshold counts |

Unknown mode → treat whole args as free-form `fallow` CLI after showing the table once.

## Rules

1. Never delete an "unused" export/file/dep without `trace` (or type-aware impact) on that symbol.
2. Never run `fallow watch`.
3. Prefer fix-in-code over config. Exception order: model in config (`entry` / `framework` / `dynamicallyLoaded`) → `@expected-unused` → `// fallow-ignore-next-line <rule> -- reason` → broad ignore last.
4. Staged unreachable code for a later wiring task: `// fallow-ignore-file unused-file -- wired by <task/name>` (see AGENTS.md). Remove in the wiring task.
5. Do not widen architecture/config ignores or `thresholdOverrides` to silence real debt without user OK.
6. After fixes that touch TS, end the turn so silent `fallow:dead-code` / `fallow:dupes` re-run. Do not manually re-run them unless the silent failure output is incomplete.
7. Report: command(s) run, exit meaning (0 clean / 1 findings / 2 runtime error), baseline pass/fail, decisive findings only. No wall of logs.
8. Complexity fixes: extract pure branches; keep orchestrators under 20/15. No single-use abstraction layers. No new tests unless the user explicitly asks.

## Config

- Policy: `.fallowrc.jsonc`
- Tasks: `mise tasks` (`fallow`, `fallow:*`)
- Cache dir `.fallow/` is gitignored
