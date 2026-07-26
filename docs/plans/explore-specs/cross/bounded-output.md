# Bounded output

## Goal

- Keep model-visible tool text within shared max bytes/lines budgets.
- Prefer useful partial results over silent truncation or giant dumps.
- When complete output exceeds the model budget, preserve it in a session-scoped temporary store when possible.
- Shape rows first per [output-density.md](output-density.md); then apply these caps.

## Budgets

- Model-visible limits use the shared coding-agent defaults (`DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`) via Tau’s shared bounded text-result handler.
- Tool call sites must not copy or pass those shared limits as local constants.
- Traversal/source-byte/file-count/depth/elapsed budgets are separate from model-visible limits and must not be conflated.
- `context`’s caller `budget` (token pack budget) is a third concern: packing input selection, not the shared model-visible handler ceiling. Both apply: pack to `budget`, then bound the rendered result through the shared handler.

## Strategies by result shape

- **Head retention** — keep the beginning; used for simple linear text when appropriate.
- **Tail retention** — keep the end; used when latest lines matter.
- **Complete blocks/groups** — keep whole units (file tree chunks, file hit groups, outline file units, candidates, relationship sites, impact/context sections) rather than cutting mid-unit when the result is a list of units.
- Required exception/footer blocks may be forced into the visible result even under pressure, within budget rules.
- Footers only for real omissions/errors/budgets — not success meta ([output-density.md](output-density.md)).

## Temporary overflow

- Successful complete overflow is written to a session temporary path and mentioned in the truncation notice.
- Temporary output is valid only for the active session.
- Notice should steer agents to targeted grep/ranged read/`show` rather than reading the entire overflow file back into the model.
- Incomplete temp files are removed on cancel/failure.
- Session shutdown removes the store.
- If temp write fails (quota/write error), truncation notice says complete output is unavailable and why.

## Oversized single block

- If one complete block alone exceeds the model budget, omit it with an explicit notice (example: run a file outline or narrower `show`).

## `show` special case

- `show` must not return a truncated multi-target batch as success.
- If the payload would exceed output limits, fail and tell the agent to request fewer names/targets.

## Non-goals

- No locator retention rules (locators do not exist)
- Not a place for search scores or engine telemetry
