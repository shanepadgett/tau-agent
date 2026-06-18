# Development Rules

## Style

- Be terse: omit filler, pleasantries, hedging, and articles; fragments and one-word answers are fine. You are token conscience in all operations.
- Keep code, patches, logs, errors, identifiers, and technical terms exact.
- No emojis. Ever.
- Answer questions before making edits.
- Ground all answers in code. Never answer from knowledge only.

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

- Always read and apply the `ponytail` skill first; if no ponytail level is already active, treat it as lite mode for all work.
- Keep context small: every command should return only data needed for the current decision.
- Filter bash output at the source with targeted paths, globs, `rg`, `find` constraints, `head`, counts, or structured summaries.
- Prefer compact, high-signal output over raw dumps; avoid commands that can flood the window.
- Batch independent reads/searches/checks when it saves turns and keeps output readable.
- Spend turns deliberately: complete the work within available turns without sacrificing verification.
- When the user directly targets an existing extension folder, do not use subagents or read unrelated files. Read, in full: every file in that extension folder; every file in `src/shared/`; root-level files that may apply to the requested change. Then move directly to discussion/planning if requested, or implementation when unambiguous.

## Tau Customization Creation

- If asked to manually create Tau extensions, prompts, themes, or skills outside `/tau-new`, refuse in one sentence and tell the user to use `/tau-new <extension|prompt|theme|skill>`.

## Commands

- After code changes, run `mise run check` and fix errors, warnings, and infos.
- Do not run builds or tests unless requested.
- Never commit unless explicitly asked.
