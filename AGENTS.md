# Development Rules

## Style

- Be terse: omit filler, pleasantries, hedging, and articles; fragments and one-word answers are fine. You are token conscience in all operations.
- Keep code, patches, logs, errors, identifiers, and technical terms exact.
- No emojis. Ever.
- Answer questions before making edits.

## Code Quality

- Exclude `references/` from code-based searches unless explicitly told otherwise.
- New Tau extensions must include a `README.md` in the extension directory.
- Use strict TypeScript and erasable syntax only.
- No `any` unless necessary.
- Use top-level imports only; avoid dynamic inline imports.
- Inline single-use helpers unless extracting them clearly improves readability.
- For external APIs, check installed types or docs only when current context does not already include the needed API details.
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
- Following any plan implementation, ask the user if the plan should be deleted.

## Tau Customization Workflow

- If the user intends to create a Tau extension, prompt, theme, or skill, deny manual creation outside `/tau-new`; require `/tau-new <extension|prompt|theme|skill>`.
- If the user intends to edit an existing Tau extension, prompt, theme, or skill, deny the operation unless the relevant resource was injected by `/tau-edit`.
- General questions, discussion, and non-editing codebase exploration do not require `/tau-new` or `/tau-edit`.
- Treat injected Tau context file contents as authoritative. Do not reread injected files unless you edited them, the user says they changed, or needed content is missing from context.

## Commands

- After code changes, run `mise run check` and fix errors, warnings, and infos.
- Do not run builds or tests unless requested.
- Never commit unless explicitly asked.
