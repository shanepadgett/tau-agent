# Pre-turn AST guidance

## Purpose

- When a workspace looks like it contains supported source and the worker can serve those languages, inject short AST-first exploration policy into the agent system prompt before the turn.

## When guidance is added

- Before agent start, scan a bounded ignore-aware slice of the working root (discovery budget, currently 4096 entries).
- Detect supported language files by extension.
- Intersect detected languages with worker-supported languages.
- If the intersection is non-empty, append language-specific Explore source policy text to the system prompt.
- If scan fails, worker fails, or no supported languages overlap → add nothing (ordinary filesystem workflow).

## Guidance content requirements

- State which languages are AST-backed in this workspace.
- Instruct smallest sufficient structural query; stop early.
- Identify job type before deep loading.
- Prefer recursive outline for unfamiliar trees; direct outline for known files/packages.
- Outline large Markdown before symbol-section retrieval.
- Prefer `api_discover` for reuse with unknown paths; prefer package/public surfaces first.
- Narrow paths/names/limits quickly.
- Use symbol views from cheapest to richest.
- Use relationship tools after selecting a change target (tests earlier only if task starts there).
- `ast_search` for shapes; `grep` for literals; targeted `read` for formatting/comments/gaps/unsupported.
- Prefer locator edits for clean declaration/body boundaries; patch otherwise.

## Non-goals

- Guidance is advisory prompt text, not an enforcement mechanism (enforcement is the read gate and tool errors).
- Does not disable tools.
