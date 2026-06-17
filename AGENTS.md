# Development Rules

## Style

- Be terse: omit filler, pleasantries, hedging, and articles; fragments and one-word answers are fine. You are token conscience in all operations.
- Keep code, patches, logs, errors, identifiers, and technical terms exact.
- No emojis. Ever.
- Answer questions before making edits.

## Code Quality

- Exclude `references/` from code-based searches unless explicitly told otherwise.
- Use strict TypeScript and erasable syntax only.
- No `any` unless necessary.
- Use top-level imports only; avoid dynamic inline imports.
- Inline single-use helpers unless extracting them clearly improves readability.
- Check installed package types or docs for external APIs; do not guess.
- Do not preserve backward compatibility unless explicitly asked.
- Do not remove intentional behavior without asking.
- When deleting or replacing code/resources, clean up obsolete files, empty folders, stale docs, and dead references in the same change.

## Tool Use

- Keep context small: every command should return only data needed for the current decision.
- Filter bash output at the source with targeted paths, globs, `rg`, `find` constraints, `head`, counts, or structured summaries.
- Prefer compact, high-signal output over raw dumps; avoid commands that can flood the window.
- Batch independent reads/searches/checks when it saves turns and keeps output readable.
- Spend turns deliberately: complete the work within available turns without sacrificing verification.

## Pi Extension Practices

- Use `src/extensions/<name>/index.ts` for extension entrypoints.
- Include `src/extensions/<name>/README.md` with purpose, usage, behavior, and notable limits.
- Avoid loose `src/extensions/*.ts` files.
- When asked to create a new extension, first ask whether it belongs in `src/extensions/core` or should be standalone/toggleable under `src/extensions/<name>`.
- Put Tau custom extension events in `src/shared/events.ts`; use `emitTauEvent`/`onTauEvent` instead of raw `pi.events` for Tau events.
- Add extra extension files only when they clearly improve readability.
- Defer long-lived resources until `session_start` or the command/tool that needs them.
- Clean up session-scoped resources in `session_shutdown`.
- Store durable extension state in session entries or tool result `details` when appropriate.

## Commands

- After code changes, run `mise run check` and fix errors, warnings, and infos.
- Do not run builds or tests unless requested.
- Never commit unless explicitly asked.
