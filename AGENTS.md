# Development Rules

## General

- Extension tool changes need user `/reload` before testing.
- Keep active work files under `.working/`. Tracked dir. Use `packages/agent/docs/` only for Tau Agent user docs.

## Scope and Behavior

- No backward compatibility unless asked.
- Do not remove intentional behavior without asking.
- No optional properties, parameters, or branches for hypothetical callers.
- Minimal to zero helper functions unless reducing duplicate code.
- Required state explicit unless domain is truly optional.

## TypeScript

- Strict TypeScript. Erasable syntax only.
- No `any` unless needed.
- No TypeScript non-null assertions (`!`). Model type, narrow, or fix boundary.
- Top-level imports only. No dynamic inline imports.
- External APIs: check installed types or docs only when current context lacks needed API detail.

## Code Shape

- Inline single-use helpers unless extraction improves readability.
- Keep tasks green and committable. Slice tasks so each change wires added code and leaves no dead files, exports, or types.
- If approved task must stage unreachable code for later integration, add local Fallow suppression with reason: `// fallow-ignore-file unused-file -- wired by <task/name>`. Remove it in wiring task. No repo-wide ignores for temporary staged code.

## Cleanup

- Delete or replace code/resources? Clean obsolete files, empty dirs, stale docs, dead refs in same change.
- Implemented from persisted plan? Ask whether to delete that plan. Name path/title. Skip if no plan artifact.

## Extension Docs

- New Tau extension needs `README.md` in extension dir.
- Tau extension README: product level only. What it is. Why it exists. How users invoke it. Update only when user-facing feature description changes. No implementation details unless asked.

## Extension Settings

- Keep extension settings in `packages/agent/extensions/<extension>/settings.ts`, next to `index.ts`. Do not place extension settings in `packages/agent/shared/`.
- Never edit `packages/agent/schemas/tau.schema.json` manually. `.pi/extensions/tau-schema-sync` regenerates it after settings changes.
- Do not write `settings.ts` and read `packages/agent/schemas/tau.schema.json` in the same parallel tool batch. Read the generated schema only in a later tool call.

## TUI

- Before creating or updating TUI components here, read `packages/agent/docs/tui.md`.
- Never hardcode keybinding hints in TUI components. Use `keyText`/`keyHint` from `@earendil-works/pi-coding-agent` so remaps work.

## Tool Use

- Keep context small. Write commands that fetch only needed data.
- Prefer compact, high-signal output. Avoid flood commands.
- Batch independent reads/searches/checks when it saves turns and output stays readable.

## Tau Customization Workflow

- Creating Tau extension, prompt, theme, or skill? Recommend `/tau-new <extension|prompt|theme|skill>`. Do not enforce.

## Tau Help Maintenance

- When adding, removing, renaming, or changing the basic usage of a Tau extension or prompt, update `packages/agent/extensions/tau-help/help.md` in the same change.

## Commands

- Never commit or open PRs.
