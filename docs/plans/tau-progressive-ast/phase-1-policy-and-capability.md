# Phase 1: Explore Policy and Capability Awareness

Status: implemented
Depends on: approved Phase 0 contract  
Produces: one capability-aware AST exploration policy owned by Explore

## Current state

Tau's Explore extension owns `ls`, `find`, `grep`, `read`, autoread behavior, `/read-stats`, read snapshots, and read-cache state. It also registers the existing `outline` and `symbol` tools and owns their worker lifecycle.

`packages/agent/extensions/soul/prompt.ts` currently tells Rok to read relevant files whole. `packages/agent/extensions/explore/read.ts` repeats that preference in the official read description. Those instructions let an agent skip structural orientation without violating guidance.

The native worker already supports TypeScript, TSX, Odin, Go, Rust, C#, Java, Kotlin, Swift, and Markdown. File and non-recursive package outlines currently provide:

- public declarations by default;
- private expansion and exact-name filters;
- complete multiline signatures, including generics, overloads, modifiers, attributes, and decorators;
- imports, exports, side effects, and declaration order;
- declaration-level parser certainty where recovery can be localized;
- numeric locators backed by fingerprinted native identity; and
- `signature`, `declaration`, and `declarationWithImports` symbol views.

Phase 1 must preserve that disclosure contract while changing policy ownership.

Existing real-package validation covers Errata, Bubble Tea, ast-grep, Guava, Okio, and Swift Collections. Keep those trials available as regression coverage alongside language fixtures.

## Implementation

1. Define one supported-language registry used by path detection, repository scanning, tool descriptions, and prompt guidance. Include canonical IDs, filename or extension rules, and worker capability mapping for all currently supported languages.
2. Add a bounded, ignore-aware scan of the working root to identify which supported languages are present. Prune ignored directories before inspecting files and stop at an explicit discovery budget.
3. Check native artifact and worker capability availability before enabling AST-first guidance. Reuse the existing worker selector and lifecycle boundary rather than adding a second health model.
4. Build Explore guidance from the intersection of detected repository languages and available worker languages.
5. Tell the agent to:
   - orient unfamiliar repositories or subtrees with recursive `outline`;
   - outline known packages or files before source reads;
   - narrow with exact names and private declarations when appropriate;
   - use `symbol` for exact declaration source; and
   - use ordinary reads for unsupported files or source outside declaration boundaries after orientation.
6. Keep `outline` and `symbol` registered as stable core Explore tools even when AST-first guidance is inactive.
7. Remove whole-file-first source guidance from Soul and the Explore read description. Preserve guidance about purposeful reads, authoritative snapshots, and context pruning.
8. Add effective-guidance tests. Assert behavior from repository capabilities rather than matching duplicated prose across extensions.
9. Preserve or repair regression coverage for the existing disclosure contract across every supported language.
10. Update the Explore README and Tau help content for the changed user-facing workflow. Add no setting.

## Required behavior

- A TypeScript repository receives TypeScript-specific AST guidance.
- A repository containing Odin and Markdown mentions both.
- A repository containing no supported source receives no AST-first requirement.
- A missing or unusable worker leaves ordinary `read` available and does not route the agent into a dead tool path.
- Worker startup remains lazy and session-scoped. Extension construction performs no native work.
- Session shutdown remains idempotent.
- Capability detection does not alter tool discovery or create a new optional mode.

## Likely files

- `packages/agent/extensions/soul/prompt.ts`
- `packages/agent/extensions/explore/index.ts`
- `packages/agent/extensions/explore/read.ts`
- `packages/agent/extensions/explore/ast-tools.ts`
- a single Explore-local language registry
- `packages/agent/test/extensions/soul/prompt.test.ts`
- Explore AST and guidance tests
- `packages/agent/extensions/explore/README.md`
- `packages/agent/extensions/tau-help/help.md`

Keep extension settings out of scope. If implementation unexpectedly needs a setting, stop and request approval before changing `settings.ts` or the generated schema.

## Validation

- Guidance tests cover supported, mixed, unsupported, and missing-worker repositories.
- Existing complete-signature fixtures remain green for every language.
- Existing required-import, module-structure, certainty, locator, cancellation, and stale-source tests remain green.
- Existing real-package validation remains green across the current TypeScript, Odin, Go, Rust, Java, Kotlin, and Swift repositories.
- No duplicate supported-language list remains in prompt or tool-description code.

## Completion

Phase 1 is complete when Explore is the sole owner of capability-aware source-exploration guidance, Soul no longer prescribes whole-file source reads, and all existing outline and symbol disclosure guarantees remain intact.
