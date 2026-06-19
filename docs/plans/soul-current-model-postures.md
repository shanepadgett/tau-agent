# Soul current-model postures

## Decision

Posture switches keep the currently selected model. Postures only change prompt guidance, active tools, and thinking level.

`act` stays `medium` thinking.

## Edits

- `src/extensions/soul/postures.ts`
  - Remove posture model candidates and preferred-model selection.
  - Remove `candidateIndex` from runtime state and persisted `tau.posture` state.
  - Remove provider-status fallback handling.
  - In `applyPosture()`, call `pi.setThinkingLevel(config.thinkingLevel)` and leave model alone.
  - Keep plan/non-plan tool switching unchanged.
  - Keep `switch_posture` continuation unchanged.

- `src/extensions/soul/README.md`
  - Replace model-preference docs with current-model behavior.
  - Keep posture/thinking docs aligned: plan/review/debug `xhigh`, act `medium`.

## Check

Run `mise run check` after implementation.
