# `/read-stats`

## Purpose

- Show estimated token and cost savings from Explore read caching and orientation behavior for the session.

## Invocation

- User command: `/read-stats`
- Requires TUI mode; non-TUI gets an error notification.

## Contents (product-level)

- Snapshot of estimated baseline vs returned tokens/cost for current context and/or whole session views as implemented by the stats panel.
- Counts by read cache mode (`baseline`, `recovery`, `unchanged`, `diff`).
- Orientation/gate telemetry totals:
  - blocked reads
  - permitted reads
  - fallback reads
  - permission breakdown by structural attempt kind / post-patch / etc.
  - bytes deflected / temporary output / direct read metrics when tracked

## Non-goals

- Not a billing system of record
- Estimates may be approximate
