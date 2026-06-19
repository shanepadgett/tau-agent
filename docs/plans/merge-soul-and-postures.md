# Merge soul and postures

## Goal

Make Lyle one cohesive system: identity plus current posture. The current split lets `soul` own Lyle's base identity while `modes` appends behavior afterward. That is the wrong seam. Plan/review/debug/act are part of how Lyle thinks and works, so they belong under soul.

This is a breaking change. No compatibility layer for `/mode`, `tau.mode`, `mode:*`, or `src/extensions/core/src/modes`.

## Current state

Relevant files now:

- `src/extensions/core/index.ts`
  - imports and calls `registerSoul(pi)`
  - imports and calls `registerModes(pi)`
- `src/extensions/core/src/soul/index.ts`
  - owns `IDENTITY_BLOCK`
  - rebuilds Pi's system prompt in `buildSoulPrompt(options)`
  - registers a `before_agent_start` hook that replaces the system prompt
- `src/extensions/core/src/modes/index.ts`
  - owns `MODE_STATE_TYPE = "tau.mode"`
  - owns `MODE_ORDER = ["plan", "act", "review", "debug"]`
  - owns posture guidance text, even though it calls it mode guidance
  - persists active mode in session entries
  - selects preferred models and thinking levels per mode
  - restricts tools in plan mode
  - updates status/footer with `mode:<name>`
  - registers `/mode`
  - registers direct shortcut commands for plan/act/review/debug; current code uses `debug-issue` for debug
  - registers `/audit` and `/debt` one-shot prompts
  - registers a second `before_agent_start` hook that appends mode guidance after soul builds the prompt
- `src/extensions/core/src/modes/README.md`
  - documents modes and `/mode`
- `src/extensions/core/src/soul/README.md`
  - documents soul
- `src/extensions/footer/index.ts`
  - renders custom footer
  - currently filters `tau-mode` out of extension statuses
  - renders footer item/status area with accent color
- `src/shared/events.ts`
  - has `setTauFooterItem(...)` used by modes

## Desired end state

File shape:

```text
src/extensions/core/src/soul/
  index.ts       // registers Lyle/soul and builds final system prompt
  postures.ts    // posture state, commands, model/tool policy, one-shot audit/debt prompts
  README.md      // soul + posture docs
```

Deleted:

```text
src/extensions/core/src/modes/
```

Core entrypoint after merge:

```ts
export default function coreExtension(pi: ExtensionAPI): void {
 registerSoul(pi);
 registerAttention(pi);
 registerCommit(pi);
 registerReference(pi);
}
```

No separate `registerModes` call. Soul owns posture registration.

## Vocabulary

Use `posture` internally and in user-facing docs.

Rename concepts:

- `ModeName` -> `PostureName`
- `ModeConfig` -> `PostureConfig`
- `ModeModelCandidate` -> `PostureModelCandidate` or just `ModelCandidate`
- `ModeState` -> `PostureState`
- `MODE_ORDER` -> `POSTURE_ORDER`
- `DEFAULT_MODE` -> `DEFAULT_POSTURE`
- `MODE_STATE_TYPE` -> `POSTURE_STATE_TYPE`
- `MODES` -> `POSTURES`
- `parseMode` -> `parsePosture`
- `parseModeCommand` -> `parsePostureCommand`
- `nextMode` -> `nextPosture`
- `applyMode` -> `applyPosture`
- `registerModes` -> removed; replaced by `createPostureController` or `registerPostures`

User-facing words:

- Use `/posture`, not `/mode`.
- Use `posture`, not `mode`, in docs, notifications, errors, status keys, command descriptions, and README text.
- Do not keep `/mode` as an alias.
- Do not read old `tau.mode` entries.
- Do not write `mode:<name>` anywhere.

## Prompt ownership

Soul must be the only prompt authority for Lyle behavior.

Current bad flow:

```text
soul before_agent_start -> replace system prompt
modes before_agent_start -> append Tau Mode block
```

Target flow:

```text
registerSoul(pi)
  create/register posture controller
  before_agent_start -> buildSoulPrompt(options, activePostureGuidance)
```

`src/extensions/core/src/soul/index.ts` should import posture support:

```ts
import { createPostureController } from "./postures.ts";

export function registerSoul(pi: ExtensionAPI): void {
 const postures = createPostureController(pi);
 pi.on("before_agent_start", (event) => ({
  systemPrompt: buildSoulPrompt(event.systemPromptOptions, postures.consumeGuidance()),
 }));
}
```

`buildSoulPrompt` should accept posture guidance:

```ts
function buildSoulPrompt(options: BuildSystemPromptOptions, postureGuidance?: string): string
```

Append posture guidance from inside soul, near the end of the prompt, after skills/project context and before runtime context or after runtime context. Pick one and keep it stable. Recommended order:

1. identity block
2. available tools
3. guidelines
4. Pi docs guidance
5. custom/append prompt
6. project context
7. skills
8. posture guidance
9. runtime date/cwd

Reason: runtime context is factual and harmless last; posture guidance stays close to the end without hiding date/cwd.

No other extension should append Lyle behavior after soul.

## Dedupe prompt language

Base identity owns permanent Lyle behavior:

- voice and terse style
- trust context first
- avoid rereads
- YAGNI ladder
- stdlib/native/internal reuse
- no fake abstractions
- deletion/simplification bias
- shortest correct diff
- validation/data safety/security/accessibility/hardware calibration stays
- cheap check for non-trivial logic
- `lean:` marker convention

Postures only say what changes for the current job.

Posture guidance must not repeat generic identity rules like:

- be concise
- skip filler
- prefer stdlib generally
- avoid over-engineering generally
- shortest diff wins generally
- no fake abstractions generally

Keep those in soul. Postures should be short task lenses.

Target posture guidance:

```txt
## Lyle Posture: Plan

- Read-only exploration. No edits or mutating commands.
- Produce a numbered plan with files, risks, and checks.
- Ask for go-ahead before implementation.
```

```txt
## Lyle Posture: Act

- Implement the smallest correct change.
- Follow existing plan if present; stop if it is wrong.
- Run the cheapest relevant check after non-trivial changes.
```

```txt
## Lyle Posture: Review

- Review only unless explicitly asked to edit.
- Find avoidable complexity and stability risk in the changed/relevant code.
- Use tags when useful: delete, shrink, dedupe, stdlib, native, internal, yagni, refactor.
- Format findings: path:Lx: <tag> <problem>. <smallest fix>.
- If clean: Lean already. Ship.
```

```txt
## Lyle Posture: Debug

- Reproduce or narrow failure before changing code.
- Prefer the smallest causal fix.
- Simplify directly related failing paths when it reduces bug surface.
- Allow a small helper only when it removes duplication or makes one current invariant obvious.
- Leave a narrow check that fails if the bug returns.
```

Notes:

- Review can still mention correctness/security/perf when complexity causes the risk. That can stay in review guidance if needed, but keep it one line.
- Debug should not say generic `use stdlib`; soul already says that. Debug should only say directly related simplification is allowed.

## Posture controller design

Create `src/extensions/core/src/soul/postures.ts` by moving and renaming the useful parts of `src/extensions/core/src/modes/index.ts`.

Small target API:

```ts
export interface PostureController {
 consumeGuidance(): string | undefined;
}

export function createPostureController(pi: ExtensionAPI): PostureController {
 // registers commands, shortcut, session hooks, provider fallback hook
 // returns active/next-turn posture guidance to soul prompt builder
}
```

`consumeGuidance()` should:

1. choose `nextTurnPosture ?? activePosture`
2. clear `nextTurnPosture`
3. return `POSTURES[posture].guidance`
4. return undefined only if there is no active posture yet

Session start should still set default posture to `act`, quietly, without persisting initial default unless current behavior intentionally persists it. Current behavior does not persist default on first session start.

## State

Use a new internal session-entry type:

```ts
const POSTURE_STATE_TYPE = "tau.posture";
```

Shape:

```ts
interface PostureState {
 name: PostureName;
 candidateIndex?: number;
}
```

Rules:

- Write only `tau.posture`.
- Read only `tau.posture`.
- Do not migrate or read `tau.mode`.
- Do not keep old `ModeState` names.
- Bad or unknown persisted posture should be ignored and default to `act`.

## Commands

Primary command:

```text
/posture
/posture plan
/posture act
/posture review
/posture debug
/posture review current diff
```

Direct posture shortcuts:

```text
/plan [prompt]
/act [prompt]
/review [prompt]
/debug [prompt]
```

One-shot commands:

```text
/audit [focus]
/debt [focus]
```

Rules:

- Delete `/mode` command entirely.
- Delete `debug-issue`; use `/debug` unless Pi has a real command collision. Current Pi built-ins do not include `/debug`.
- If a posture command has no trailing text, switch posture and stop.
- If a posture command has trailing text, switch posture first, then submit the trailing text as a user message in that posture.
- If `/posture` has no args, open the picker as current `/mode` does.
- If `/posture` gets an unknown posture, error should say `Unknown posture "...". Use: plan, act, review, debug`.
- Notifications should say `Posture: Review`, not `Mode: Review`.
- Command descriptions should say posture, not mode.

Direct command behavior sketch:

```ts
for (const name of POSTURE_ORDER) {
 pi.registerCommand(name, {
  description: `Switch to ${name} posture; with text, submit it in that posture`,
  handler: async (args, ctx) => runPostureCommand(name, commandPrompt(args), ctx),
 });
}
```

`/posture review current diff` should parse as:

```ts
{ name: "review", prompt: "current diff" }
```

Do not create a generic command framework.

## Audit and debt

Keep `/audit` and `/debt` in posture controller. They are posture-adjacent Lyle behaviors, not separate extensions.

Rules:

- They are one-shot prompts.
- They do not persist active posture.
- They borrow review guidance for that turn via `nextTurnPosture = "review"`.
- They should not change footer text or session posture.
- They should not mutate tools/model state unless there is already a small obvious helper for one-turn model policy. Do not build model restore machinery for this.

Keep existing prompt behavior with these refinements:

- `/audit` should say scan repo tree and skip `.git`, `node_modules`, `dist`, `build`, `coverage`, generated output, `references`, and agent cache/session/temp dirs.
- `/debt` should scan `lean:` and legacy `ponytail:` markers.

## Model and tool policy

Carry over current behavior, renamed:

- `plan`, `review`, `debug` use quality model candidates and `xhigh` fallback thinking.
- `act` uses act model candidates and lower thinking.
- `plan` snapshots previous tools and switches to read-only tools.
- leaving `plan` restores previous tools plus required non-plan tools.
- provider fallback still advances to next preferred candidate for the next turn on `402`, `403`, `429`, or `5xx`.

Rename helper functions and variables from mode to posture.

Avoid new abstraction. This can mostly be a move plus rename.

## Footer and status

User-facing footer text should be just the posture name:

```text
review
debug
act
plan
```

No prefix:

```text
posture:review
mode:review
```

Implementation details:

- Use item id `tau-posture`.
- Use status key `tau-posture` if status is still needed.
- `setTauFooterItem(pi, { id: "tau-posture", text: activePosture })`.
- `ctx.ui.setStatus("tau-posture", activePosture)` if keeping status.
- Update footer filtering from `tau-mode` to `tau-posture` to avoid duplicate rendering if both status and footer item remain.
- Render the custom footer posture text muted, same as the rest of the custom footer chrome. The current footer renders bottom-right items with accent color; change it to `theme.fg("dim", bottomRight)` unless there is a better existing muted path.
- Remove old `tau-mode` ids.

If status plus footer item is redundant, prefer deleting `ctx.ui.setStatus(...)` for posture and using only `setTauFooterItem(...)`. Keep the smallest behavior that still shows posture in the custom footer.

## Shortcut key

Current shortcut is `Ctrl+Shift+M` for cycling modes.

Do not add keybinding churn unless necessary. Keep the shortcut, but rename description and implementation wording:

```text
Cycle Lyle posture
```

If a better key is wanted later, handle it separately.

## Docs

Delete `src/extensions/core/src/modes/README.md` with the module.

Expand `src/extensions/core/src/soul/README.md` to cover:

- soul owns Lyle identity and posture
- posture command usage
- direct shortcuts
- audit/debt one-shots
- default posture is `act`
- footer shows plain posture name
- plan is read-only
- posture state is stored as `tau.posture`
- no `/mode` command

Update any docs that mention modes:

- `src/extensions/core/README.md` if needed
- root `README.md` only if it documents commands later
- docs/plans should not be treated as product docs unless they would confuse future implementers

Search excluding `references/`, `node_modules/`, and `.pi/`:

```bash
rg -n "mode|Mode|MODE|tau-mode|tau\.mode|debug-issue|registerModes|src/modes" src README.md docs AGENTS.md -g '!docs/plans/**'
```

After implementation, legitimate leftovers should be only unrelated words like model mode or TUI mode. No Tau workflow mode references should remain.

## Implementation steps

1. Read current files near edit points:
   - `src/extensions/core/index.ts`
   - `src/extensions/core/src/soul/index.ts`
   - `src/extensions/core/src/modes/index.ts`
   - `src/extensions/core/src/soul/README.md`
   - `src/extensions/core/src/modes/README.md`
   - `src/extensions/footer/index.ts` around footer item rendering/filtering

2. Move `src/extensions/core/src/modes/index.ts` to `src/extensions/core/src/soul/postures.ts`.
   - Use apply-patch move support or a real git move if doing this manually.
   - Rename all mode symbols to posture symbols.
   - Remove `registerModes`; export `createPostureController`.

3. Update `src/extensions/core/src/soul/index.ts`.
   - Import `createPostureController`.
   - Instantiate it inside `registerSoul`.
   - Pass `postures.consumeGuidance()` into `buildSoulPrompt`.
   - Add posture guidance inside the prompt array.
   - Keep identity block as the only permanent Lyle behavior source.

4. Update posture guidance text.
   - Use the target `Lyle Posture` text above.
   - Strip generic duplicate behavior already in `IDENTITY_BLOCK`.
   - Keep review/debug nuances from the Ponytail absorption work.

5. Replace commands.
   - Delete `/mode` registration.
   - Add `/posture` registration.
   - Use posture terminology in completions, picker title, errors, and notifications.
   - Use `/debug`, not `/debug-issue`.
   - Keep `/plan`, `/act`, `/review`, `/debug`, `/audit`, `/debt`.

6. Update state.
   - Replace `tau.mode` with `tau.posture`.
   - Do not read old `tau.mode`.
   - Rename persisted state types and helpers.

7. Update footer/status.
   - Replace `tau-mode` with `tau-posture`.
   - Render plain posture name with no prefix.
   - Make the footer item muted.
   - Remove old mode status/filter text.

8. Update `src/extensions/core/index.ts`.
   - Remove `registerModes` import and call.

9. Delete `src/extensions/core/src/modes/README.md` and the empty `modes` directory.

10. Update `src/extensions/core/src/soul/README.md`.
    - Move useful docs from modes README into soul README.
    - Use posture terminology only.

11. Search for leftovers.
    - Exclude `references/`, `node_modules/`, `.pi/`, and archived plans unless checking intentionally.
    - Fix product/source leftovers.

12. Add/update self-checks in `postures.ts`.
    - Keep the existing `demo()` pattern.
    - Rename it to posture concepts.
    - Cover parser behavior:
      - `parsePosture(" PLAN ") === "plan"`
      - `parsePostureCommand(" review current diff ")` returns review/current diff
      - bad posture returns undefined
      - `commandPrompt("  failing test ") === "failing test"`
    - Cover cycling:
      - `nextPosture("debug") === "plan"`
    - Cover tool helper behavior.
    - Cover audit/debt prompt builders include required markers/tags.
    - Update demo path check to `src/extensions/core/src/soul/postures.ts`.

13. Run required check:

```bash
mise run check
```

Fix all errors, warnings, and infos. If it auto-fixes and reports no errors, do not rerun just for formatting.

## Acceptance checklist

- `src/extensions/core/src/modes/` is gone.
- `src/extensions/core/index.ts` no longer imports or calls `registerModes`.
- `registerSoul` creates the posture controller.
- Only soul's `before_agent_start` hook adds Lyle identity and posture guidance.
- No second prompt hook appends posture guidance.
- Command is `/posture`, not `/mode`.
- `/mode` is not registered.
- `/debug` is registered directly.
- `debug-issue` is gone.
- session state key is `tau.posture`.
- `tau.mode` is gone from source.
- footer/status key is `tau-posture`.
- footer displays `review`, not `posture:review` or `mode:review`.
- posture footer text is muted in custom footer.
- docs use posture terminology.
- posture guidance does not repeat generic soul identity rules.
- `mise run check` passes.

## Things not to do

- Do not keep `/mode` as alias.
- Do not migrate old `tau.mode` state.
- Do not leave a `modes` wrapper module.
- Do not create a separate posture extension.
- Do not build a generic posture plugin system.
- Do not add config-driven postures.
- Do not preserve `debug-issue` unless `/debug` is proven impossible and user approves.
- Do not duplicate Lyle identity text inside posture guidance.
