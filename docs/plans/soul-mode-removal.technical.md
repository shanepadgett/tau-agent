# Soul Mode Removal Technical Plan

## Goal

Remove Soul's branch-scoped modes. Leave Soul responsible only for Rok's stable system prompt, frozen runtime/project context, and the existing `extensions.soul.enabled` setting. Add three package prompt templates for feature planning, implementation planning, and implementation execution.

## Completion Condition

Implementation is complete when:

- Soul registers no mode commands, renderers, footer items, state, markers, or context hooks.
- Soul's core system prompt contains only guidance that applies in every chat.
- `/plan-feature`, `/plan-implementation`, and `/implement` are available as Pi package prompt templates and enforce the artifact workflow below.
- All mode files, tests, documentation, schema text, imports, and references are removed or updated.
- Existing Rok prompt assembly, runtime-context freezing, project instructions, skill context, and `enabled` behavior still work.

## Current Shape

- `src/extensions/soul/index.ts` loads Soul settings on `session_start`, freezes runtime context, replaces the system prompt in `before_agent_start`, derives mode state on `session_start` and `session_tree`, injects mode context during `context`, registers four mode commands and a marker renderer, and publishes the active mode through footer event `tau-soul-mode`.
- `src/extensions/soul/modes/runtime.ts` owns persisted branch state (`tau:soul.mode-state`), hidden context (`tau:soul.mode-context` and legacy `tau:soul.mode`), visible markers (`tau:soul.marker`), command execution, and marker rendering.
- `src/extensions/soul/modes/definitions/` stores planning, review, debugging, and implementation mode prompts.
- `src/extensions/soul/prompt.ts` mixes permanent Rok behavior with planning, design, debugging, mutation, cleanup, and execution rules.
- `package.json` already publishes the root `prompts/` directory through `pi.prompts`. Pi discovers Markdown files there non-recursively and derives the slash command from the filename. No TypeScript registration or package change is needed.
- `test/extensions/soul/modes/runtime.test.ts` tests machinery that will be deleted. `test/extensions/soul/prompt.test.ts` protects runtime-context snapshot behavior and remains relevant.

## Chosen Design

Keep Soul as one small extension and keep `prompt.ts` as the owner of prompt assembly. Remove the complete `modes/` subtree rather than retaining generic command or state machinery. Add the three workflows as standalone Markdown prompt templates under the package's existing `prompts/` boundary.

This shape uses Pi's native prompt-template discovery, removes branch-state mutation and per-turn mode-context rewriting, and leaves the system-prompt prefix stable. The prompt templates expand into user messages only when invoked.

### Serious Alternative Considered

Move permanent, planning, and execution guidance into separate TypeScript prompt-fragment modules and compose them from Soul. Rejected. Planning and execution are user-invoked workflows, so composing them into the system prompt preserves the cache and ownership problem. A separate TypeScript module for the remaining core would also create a second file with one consumer and no clearer boundary.

Keeping dormant mode parsing to filter old session entries was also considered. Rejected. Old custom entries are inert once Soul removes the `context` hook and renderer registration. Retaining compatibility code would violate the explicit requirement to delete all mode machinery.

## Resulting Control Flow

### Soul

1. `session_start` loads `extensions.soul.enabled` and freezes runtime context for the session.
2. `before_agent_start` returns nothing when Soul is disabled.
3. When enabled, `before_agent_start` lazily freezes runtime context if needed and calls `buildRokPrompt(event.systemPromptOptions, runtimeContext)`.
4. `buildRokPrompt` assembles the stable Rok core, tool guidance, Pi/Tau documentation guidance, custom and appended system prompts, project instructions, skills, and frozen date/CWD/root snapshot exactly as it does now.

No `session_tree`, `context`, command, message-renderer, or footer-event path remains in Soul.

### Prompt templates

Pi loads `prompts/*.md` through `package.json#pi.prompts`. Each file uses frontmatter with `description` and an optional slug/topic `argument-hint`. Invocation expands the Markdown into the user prompt; no extension runtime state is involved.

Planning state lives only in `docs/plans/`. A fresh chat must be able to continue from the artifacts without conversation history.

## Prompt Responsibilities

### `prompts/plan-feature.md`

Purpose: turn rough feature intent into either a brief direct-implementation plan or a full behavioral specification.

Workflow:

1. Start with rough conversation. Establish what the user means before searching plan files or beginning pointed questions.
2. When continuation status is unclear, ask whether this is new work or an existing plan. Read only the plan identified by the user.
3. Confirm a goal and a separate exit condition.
4. Inspect current behavior, constraints, and user-facing seams relevant to the framed work.
5. Apply Code Ladder rung 1: confirm the feature needs to exist and cut speculative scope.
6. Choose the smallest sufficient path:
   - Simple work: write `docs/plans/<slug>.plan.md`.
   - Full work: maintain `docs/plans/<slug>.scratch.md`, then write `docs/plans/<slug>.spec.md` in EARS-style system-behavior statements.
7. Ask one pointed question at a time only after the problem boundary is clear enough. Promote reconciled truth into the plan or spec; keep unresolved questions and temporary research in scratch.
8. Finish only after feature outcomes, boundaries, and completion criteria are clear. Full planning also requires the scratch file to contain no unresolved or leftover material.

The simple plan stays brief but self-contained: goal, behavior, scope, relevant code, implementation direction, edge cases, and completion criteria. It goes directly to `/implement` and does not go through `/plan-implementation`.

The full spec describes required system behavior. It excludes PRD material, implementation design, unresolved choices, transcripts, and stale research. Its handoff is `/plan-implementation`.

### `prompts/plan-implementation.md`

Purpose: turn one `docs/plans/<slug>.spec.md` into an executable technical design.

Workflow:

1. Start with rough conversational framing. Do not search plan files until the user identifies the work or continuation status must be clarified.
2. Require a full spec. Stop if the spec is missing, contradictory, or leaves feature behavior undecided.
3. Confirm the technical-planning goal and a separate exit condition.
4. Reuse `docs/plans/<slug>.scratch.md` for open questions, repo findings, and temporary design work.
5. Research only the framed feature's code ownership, callers where needed, repository patterns, dependencies, refactor opportunities, and concrete implementation paths.
6. Apply Code Ladder rungs 2 through 8 and Design It Twice. Compare the current or first viable design with at least one serious alternative when structure is non-trivial.
7. Write `docs/plans/<slug>.technical.md` with the chosen design, serious alternatives and tradeoffs, exact files and owners, data/control flow, reuse and refactors, deletions, implementation order, edge cases, validation, and exact code references where useful.
8. Keep the technical plan self-contained and precise enough for a less-capable agent without prescribing every line of code.
9. Finish only after `technical.md` can guide a fresh implementation chat, no basic design question remains, and scratch contains no unresolved or leftover material.

### `prompts/implement.md`

Purpose: execute the identified planning artifacts without reopening settled scope.

Workflow:

1. Resolve the slug or artifact path from the invocation or conversation. Ask when ambiguous.
2. Require either one `docs/plans/<slug>.plan.md`, or both `docs/plans/<slug>.spec.md` and `docs/plans/<slug>.technical.md`. Invoking `/implement` for those artifacts authorizes execution.
3. Read the identified artifacts in full. For a full plan, read the spec before the technical plan.
4. Stop on conflicting artifacts, unresolved decisions, or code evidence that invalidates the planned design. Do not invent public behavior or silently redesign.
5. Implement only the planned scope and follow the technical plan's boundaries and order. Read additional code only when a named owner, direct dependency, or contradiction requires it.
6. Remove replaced code, stale references, unused exports, and obsolete resources in the same change.
7. Report only non-obvious caveats after implementation.

## Core Prompt Split

Edit `ROK_CORE_PROMPT` in `src/extensions/soul/prompt.ts` by responsibility rather than copying mode text wholesale.

Keep:

- Rok persona and terse voice.
- User authority, explicit scope, and public-surface approval rules.
- Safety rules for destructive, security, access, money, and irreversible work.
- Purposeful context reading and trust in selected snapshots.
- Concise question, answer, and final-response behavior.

Move out or delete from the core:

- Code Ladder: rung 1 belongs to `plan-feature.md`; rungs 2-8 belong to `plan-implementation.md`. Execution follows the technical plan rather than carrying the ladder globally.
- Design It Twice and technical design comparison: `plan-implementation.md`.
- File taxonomy, abstraction tests, refactor policy, standard-library/native/dependency selection, and implementation-shape guidance: primarily `plan-implementation.md`, with only execution constraints needed to obey a plan in `implement.md`.
- Mutation-tool choice, cleanup, and implementation mechanics: `implement.md`.
- Bug-fix and debug workflow: removed with debug mode; no replacement command was approved.
- Review-mode attack format and findings taxonomy: removed with review mode; no replacement command was approved.
- Planning artifact and interview discipline: the two planning prompts.

Do not alter `buildRokPrompt`, runtime snapshot helpers, Pi/Tau documentation guidance, project-context formatting, skill formatting, or tool/guideline assembly unless removing a now-unused import requires it.

## File Changes

### Add

- `prompts/plan-feature.md`: feature-planning template described above.
- `prompts/plan-implementation.md`: implementation-planning template described above.
- `prompts/implement.md`: plan execution template described above.

### Modify

- `src/extensions/soul/index.ts`: remove mode imports, footer constant/helper, `session_tree`, `context`, mode command registration, and renderer registration. Preserve setting load, runtime freeze, and `before_agent_start` prompt replacement.
- `src/extensions/soul/prompt.ts`: reduce `ROK_CORE_PROMPT` to permanent responsibilities. Preserve prompt assembly and runtime-context code.
- `src/extensions/soul/settings.ts`: change the `enabled` description to cover only Tau's Rok system prompt. Keep key, default, optional schema property, and setting behavior unchanged.
- `src/extensions/soul/README.md`: remove command, footer, marker, and branch-state documentation. Describe stable Rok prompt/runtime context and the `enabled` setting. Keep `/reload` guidance.
- `schemas/tau.schema.json`: regenerate from `src/extensions/soul/settings.ts` with the repository schema-sync path; do not hand-edit it.

### Delete

- `src/extensions/soul/modes/index.ts`
- `src/extensions/soul/modes/runtime.ts`
- `src/extensions/soul/modes/definitions/index.ts`
- `src/extensions/soul/modes/definitions/plan-mode.ts`
- `src/extensions/soul/modes/definitions/review-mode.ts`
- `src/extensions/soul/modes/definitions/debug-mode.ts`
- `src/extensions/soul/modes/definitions/implement-mode.ts`
- `test/extensions/soul/modes/runtime.test.ts`

No change is needed in `package.json`: its existing `"prompts": ["./prompts"]` entry exposes all three templates.

## Implementation Order

1. Add the three prompt templates so moved guidance has a destination before shrinking Soul.
2. Reduce `ROK_CORE_PROMPT` to permanent responsibilities while preserving `buildRokPrompt` and context assembly.
3. Collapse `src/extensions/soul/index.ts` to setting load, runtime freezing, and system-prompt replacement.
4. Delete the mode runtime, definitions, exports, and mode runtime test.
5. Update Soul's setting description and README, then regenerate `schemas/tau.schema.json` from `settings.ts`.
6. Search for the removed command names, custom types, footer ID, mode symbols, and old `.working/docs/plans/` paths. Only historical planning input under `.agents/interviews/soul-mode-removal/` may still mention them.
7. Run repository validation and manually verify template discovery after `/reload`.

## Edge Cases and Boundaries

- Existing sessions may retain `tau:soul.mode-state`, `tau:soul.marker`, `tau:soul.mode-context`, or `tau:soul.mode` entries. The implementation must not migrate or delete session history. With no Soul mode hooks or renderer, those entries have no active behavior.
- Disabling Soul still suppresses Rok's system-prompt replacement. Prompt templates remain independently discoverable because Pi loads them from the package, outside Soul's `enabled` setting.
- Runtime context remains frozen once per session, including fallback initialization when `before_agent_start` occurs without `session_start` state.
- Prompt templates must use `docs/plans/`, never `.working/docs/plans/` or `.agents/interviews/`.
- Planning prompts return short chat summaries and write substantive content into artifacts. They must not duplicate full plans into chat.
- Full planning cannot finish with unresolved questions disguised as notes. Scratch content must be promoted, explicitly discarded with user agreement, or moved to an agreed destination.

## Validation

Automated checks must prove:

- TypeScript compiles after all mode imports and exports disappear.
- Existing `test/extensions/soul/prompt.test.ts` still passes, preserving gitignore-aware runtime snapshots.
- Schema generation reports no drift and the Soul setting description matches `settings.ts`.
- Repository lint, formatting, Markdown lint, unit tests, and dead-code checks pass.

Manual checks after `/reload`:

1. Confirm `/plan-feature`, `/plan-implementation`, and `/implement` appear with correct descriptions and argument hints.
2. Confirm `/plan-mode`, `/review-mode`, `/debug-mode`, and `/implement-mode` no longer appear.
3. Start an enabled Soul session and confirm Rok's system prompt still contains project instructions, skills, tools, date, CWD, and root snapshot.
4. Disable Soul, start a new session, and confirm Soul does not replace the system prompt while the three prompt templates remain available.
5. Open or branch an older session containing mode entries and confirm Soul adds no mode footer, injected context, or mode behavior.
