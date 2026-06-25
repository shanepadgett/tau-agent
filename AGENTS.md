# Development Rules

## General

- Any change to extension tools requires the user to /reload before you can test the changes

## Style

- Be terse: omit filler, pleasantries, hedging, and articles; fragments and one-word answers are fine. You are token conscience in all operations.
- Keep code, patches, logs, errors, identifiers, and technical terms exact.
- No emojis. Ever.
- Answer questions before making edits.

## Code Quality

- New Tau extensions must include a `README.md` in the extension directory.
- Keep Tau extension README files product-level: what it is, why it exists, and how users invoke it. Do not update READMEs for minor/internal changes unless the user-facing feature description materially changes. No implementation details unless explicitly asked.
- Use strict TypeScript and erasable syntax only.
- No `any` unless necessary.
- Use top-level imports only; avoid dynamic inline imports.
- Inline single-use helpers unless extracting them clearly improves readability.
- For external APIs, check installed types or docs only when current context does not already include the needed API details.
- Do not preserve backward compatibility unless explicitly asked.
- Do not remove intentional behavior without asking.
- When deleting or replacing code/resources, clean up obsolete files, empty folders, stale docs, and dead references in the same change.
- Never hardcode keybinding hints in TUI components. Use `keyText`/`keyHint` from `@earendil-works/pi-coding-agent` so remaps are respected.

## Tool Use

- When using `read` tool, always read entire file, never ranges.
- Keep context small: every bash command should return only data needed for the current decision.
- Filter bash output at the source with targeted paths, globs, `rg`, `find` constraints, `head`, counts, or structured summaries.
- Prefer compact, high-signal output over raw dumps; avoid commands that can flood the window.
- Batch as many independent reads/searches/checks as possible when it saves turns and keeps output readable.
- Spend turns deliberately: complete the work within available turns without sacrificing verification.
- Local extensions under `.pi/extensions/` import from `src/shared/` and are first-party consumers. Treat them as in-scope for dead-code, import-graph, and refactor-safety checks (grep, find, references), not just `src/`.
- After implementing from a persisted/written plan, ask whether to delete that specific plan and name its path/title. Do not ask when there was no actual plan artifact.
- After implementing or fixing something from `.pi/tau/ideas.jsonl`, ask whether to remove the completed idea from that file.

## Tau Customization Workflow

- If the user intends to create a Tau extension, prompt, theme, or skill, recommend `/tau-new <extension|prompt|theme|skill>`, but you dont need to enforce it.
- If the user intends to edit an existing Tau extension, prompt, theme, or skill, recommend they use `/tau-edit`, but it's okay if they dont.
- Treat injected Tau context file contents as authoritative. Do not reread injected files unless you edited them, the user says they changed, or needed content is missing from context.

## Commands

- Never commit unless explicitly asked.
