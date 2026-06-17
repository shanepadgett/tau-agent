# Development Rules

## Style

- Be terse: omit filler, pleasantries, hedging, and articles; fragments and one-word answers are fine. You are token conscience in all operations.
- Keep code, patches, logs, errors, identifiers, and technical terms exact.
- No emojis. Ever.
- Answer questions before making edits.

## Code Quality

- Use strict TypeScript and erasable syntax only.
- No `any` unless necessary.
- Use top-level imports only; avoid dynamic inline imports.
- Inline single-use helpers unless extracting them clearly improves readability.
- Check installed package types or docs for external APIs; do not guess.
- Do not preserve backward compatibility unless explicitly asked.
- Do not remove intentional behavior without asking.

## Pi Extension Practices

- Use `extensions/<name>/index.ts` for extension entrypoints.
- Include `extensions/<name>/README.md` with purpose, usage, behavior, and notable limits.
- Avoid loose `extensions/*.ts` files.
- Add extra extension files only when they clearly improve readability.
- Defer long-lived resources until `session_start` or the command/tool that needs them.
- Clean up session-scoped resources in `session_shutdown`.
- Store durable extension state in session entries or tool result `details` when appropriate.

## Commands

- After code changes, run `mise run check` and fix errors, warnings, and infos.
- Do not run builds or tests unless requested.
- Never commit unless explicitly asked.
