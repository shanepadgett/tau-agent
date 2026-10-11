# Development Rules

## General

- Extension tool changes need user `/reload` before testing.
- Keep active work files under `docs/plans/`. Tracked dir. Use `packages/agent/docs/` only for Tau Agent user docs.
- Read `docs/standards/agent-runtime.md` before adding or changing extension model selection, thinking levels, or fallback policy.
- Keep Pi development pins separate from the supported minimum; follow the Pi Compatibility rules below.

## Pi Compatibility

- Root Pi development dependencies stay exactly pinned and synchronized. Both published packages use aligned `>=x.y.z` Pi peer minimums, which the development pins must satisfy.
- Routine dependency updates and Tau releases do not raise the Pi minimum. Raise it only when an adopted API or required behavior cannot work safely at the current minimum, with user approval and a documented reason. An upstream breaking release alone does not justify dropping older hosts.
- Prefer capability detection and safe fallbacks for newer Pi APIs within the supported range. Preserve correctness, cache safety, cancellation, and security; do not silently drop required behavior. If no safe fallback exists, discuss raising the minimum before implementation.
- Check API availability at the minimum, not only in the installed development version. Do not unconditionally import newer named exports or depend on newer types to prove older runtime support. Keep compatibility handling at the Pi integration boundary, not spread across callers. Do not add branches for hosts below the declared minimum.
- When the minimum changes, update both published manifests, `README.md`, `packages/agent/README.md`, and their install commands together. Keep routine development-pin updates independent of those minimums.

## Scope and Behavior

- Pi compatibility follows the declared supported range. No other backward compatibility unless asked.
- Do not remove intentional behavior without asking.
- No optional properties, parameters, or branches for hypothetical callers.
- Minimal to zero helper functions unless reducing duplicate code.
- Required state explicit unless domain is truly optional.

## Tests

- Never add new tests (unit, integration, e2e, fixtures, or snapshots). The suite is being unwound; do not grow it.
- Do not update existing tests unless the user explicitly asks.
- Do not add test-only exports, helpers, or scaffolding.

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

## Cache Safety

- Treat cache behavior as a correctness requirement for any change that can affect model requests, directly or indirectly.
- Before implementation, identify which final serialized request fields can change across consecutive calls. Preserve the longest stable prefix and place unavoidable mutable data after stable cached content.
- Validate the final request after all transformations and lifecycle behavior. An intermediate representation or isolated unit can look stable while the provider payload is not.
- When changing cache-sensitive paths, reason about consecutive requests: unchanged content must keep the same fingerprint and necessary invalidation must start no earlier than intended. Do not add tests for this unless the user explicitly asks.

## Tool Results

- New or changed tools capable of returning unbounded model-visible text must construct their result through Tau's shared bounded text-result handler once it exists. Inherently bounded and non-text results may bypass it for a stated reason.
- The shared handler owns Pi's exported `DEFAULT_MAX_BYTES` and `DEFAULT_MAX_LINES`; tool call sites must not copy or pass those limits.
- Select overflow behavior by result shape. Head retention reuses Pi's exported `truncateHead`; tail retention reuses `truncateTail`; Tau handles complete groups or blocks for structured output; callers may use pagination where they can continue safely.
- Route useful complete overflow through the shared session-scoped temporary store. Incomplete files are removed on cancellation or failure, successful files remain for the active session, and session shutdown removes the store.
- Keep traversal, source-byte, file-count, depth, and elapsed-work budgets separate from model-visible output limits.
- Keep tool-specific result shapes and TUI rendering outside the shared handler. The handler standardizes bounded model content, overflow metadata, temporary-file ownership, and cleanup.

## Cleanup

- Delete or replace code/resources? Clean obsolete files, empty dirs, stale docs, dead refs in same change.
- Always delete a persisted plan once the user confirms its work is complete. Do not ask for separate permission to delete it.

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

- Keep context small. Use concise, read-only shell commands and pipelines to select only the needed data; use tools such as `rg`, `find`, and `jq` to filter at the source, and bound output instead of dumping broad results.
- Use `script_runner` for custom Python, Node, or Deno code, including one-off calculations, parsing, transformations, and automation. Never pass custom code to these runtimes through bash with `-c`/`-e`, a heredoc, a temporary source file, or a wrapper.
- Use bash for direct shell commands, focused read-only filtering, existing project commands, and genuinely shell-specific process orchestration. Use a bash script only when shell behavior is required and no suitable direct command, pipeline, or dedicated tool fits. Do not move custom code into bash just to avoid review.
- Prefer naturally fitting, known-safe read-only bash commands when they can do the job; they may bypass a reviewer call. Do not reshape a task just to reach that fast path. Keep commands visible and run project tools such as builds, tests, lint, and type checks directly by name.
- Batch independent reads/searches/checks when it saves turns and output stays readable.

## Tau Customization Workflow

- Creating Tau extension, prompt, theme, or skill? Recommend `/tau-new <extension|prompt|theme|skill>`. Do not enforce.

## Tau Help Maintenance

- When adding, removing, renaming, or changing the basic usage of a Tau extension or prompt, update `packages/agent/extensions/tau-help/help.md` in the same change.

## Commands

- Never commit or open PRs.
