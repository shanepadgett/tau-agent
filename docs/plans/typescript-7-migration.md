# TypeScript 7 migration (separate from routine dep bump)

Status: **applied 2026-07-25.**

## Goal

- Drop `@typescript/native-preview` / `tsgo` (preview line obsolete).
- Use official `typescript@7` native `tsc`.
- Keep Tau typecheck green under TS7.

## Applied

| Action | Detail |
| --- | --- |
| Removed | `@typescript/native-preview` |
| Set | `typescript` `7.0.2` |
| Wired | `mise.toml` `check:types` → `./node_modules/.bin/tsc --noEmit` |
| Validated | dry-run + post-install `tsc --noEmit` clean (0 errors). No Tau source fixes required. |

## Notes

- Pi has no peer/runtime TS dependency; risk was Tau source + inference only.
- `typebox` stayed `1.1.38` (no TS7 force).
- Pre-apply dry-run: temp `typescript@7.0.2`, `tsc --noEmit` EXIT 0, pins restored, then full apply.

## Decisions log

- 2026-07-25: Discussed in dep update pass. Approved direction (drop preview, use `typescript@7`) but deferred execution to this plan.
- 2026-07-25: Dry-run under `typescript@7.0.2` clean. Full migration applied.
