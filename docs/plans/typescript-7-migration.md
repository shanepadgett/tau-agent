# TypeScript 7 migration (separate from routine dep bump)

Status: **planned, not started.** Do not fold into `docs/plans/dep-update-2026-07-25.md` apply batch.

## Goal

- Drop `@typescript/native-preview` / `tsgo` (preview line obsolete).
- Use official `typescript@7` native `tsc`.
- Keep Tau typecheck green under TS7.

## Why separate

5.9 → 7 is real checker work, not a pure pin bump. Routine deps (Pi, oxfmt/oxlint, vitest, types/node, drop toon) stay on the other plan.

## Current

| Pin | Version | Role |
| --- | --- | --- |
| `typescript` | 5.9.3 | package present; not what `check:types` runs |
| `@typescript/native-preview` | 7.0.0-dev.20260120.1 | provides `tsgo` |
| `mise.toml` `check:types` | `./node_modules/.bin/tsgo --noEmit` | CI/local truth |

`tsconfig.json`: strict, `erasableSyntaxOnly`, `skipLibCheck: true`, includes `packages/*` + `.pi/extensions`.

## Target

| Action | Detail |
| --- | --- |
| Remove | `@typescript/native-preview` (and lock transitive platform previews) |
| Set | `typescript` `7.0.2` (or latest 7.x at apply time — re-resolve then) |
| Wire | `check:types` → `./node_modules/.bin/tsc --noEmit` |
| Validate | full typecheck; fix Tau errors only; no drive-by refactors |

`tsc` in TS7 is a Node wrapper over optional `@typescript/typescript-<platform>` native bins.

## Pi / coupling

- Pi does **not** peer- or runtime-depend on `typescript`.
- `pi-coding-agent` has `typescript` as **devDependency** only (upstream build).
- Tau consumes Pi via published JS + `.d.ts`.
- `skipLibCheck: true` limits fallout from Pi `.d.ts` under new checker.
- Risk is Tau source + inference against Pi types, not Pi runtime or a peer fight.

## Likely work

1. Re-resolve latest `typescript@7` at apply time.
2. Manifest + mise/check script swap (`tsgo` → `tsc`).
3. `npm install`; confirm platform native optional dep present.
4. Run typecheck; fix errors forced by 5.9→6 bridge defaults and TS7 native.
5. Smoke editor/workspace TS if needed (TS7 LSP story differs from old tsserver path).
6. Do not bump `typebox` in this task unless a TS7 error truly forces it (prefer stay 1.1.38 with Pi).

## Non-goals

- Adopting new TS7-only syntax for style.
- Enabling new strict flags beyond what breaks.
- Reworking Pi integration APIs without a type error driving it.

## Decisions log

- 2026-07-25: Discussed in dep update pass. Approved direction (drop preview, use `typescript@7`) but **deferred execution** to this plan as its own task.
