# Bounded output

## Goal

- Keep model-visible tool text within shared max bytes/lines budgets.
- Prefer useful partial results over silent truncation or giant dumps.
- When complete output exceeds the model budget, preserve it in a session-scoped temporary store when possible.

## Budgets

- Model-visible limits use the shared coding-agent defaults (`DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`).
- Traversal/source-byte/file-count/depth/elapsed budgets are separate from model-visible limits and must not be conflated.

## Strategies by result shape

- **Head retention** — keep the beginning; used for simple linear text when appropriate.
- **Tail retention** — keep the end; used when latest lines matter.
- **Complete blocks/groups** — keep whole units (files, candidates, matches, relationship sites) rather than cutting mid-unit when the result is a list of units.
- Required exception/footer blocks may be forced into the visible result even under pressure, within budget rules.

## Temporary overflow

- Successful complete overflow is written to a session temporary path and mentioned in the truncation notice.
- Temporary output is valid only for the active session.
- Notice should steer agents to targeted grep/ranged read rather than reading the entire overflow file back into the model.
- Incomplete temp files are removed on cancel/failure.
- Session shutdown removes the store.
- If temp write fails (quota/write error), truncation notice says complete output is unavailable and why.

## Oversized single block

- If one complete block alone exceeds the model budget, it may be omitted with an explicit notice (example: run a non-recursive outline for that file).

## Symbol special case

- `symbol` must not return a truncated declaration batch as success.
- If the symbol payload would exceed output limits, fail and tell the agent to request fewer locators.

## Locator interaction

- See [locators.md](locators.md): IDs not shown to the model after overflow trimming are not left live.
