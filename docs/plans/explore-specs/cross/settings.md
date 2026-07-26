# Explore settings

## Extension key

- `explore`

## `read`

- `structureThresholdLines` (number, default `200`)  
  Supported source files at or under this line count may be full-read. Above it, a full read returns outline only ([read-policy.md](read-policy.md)).
- `maxRangeLines` (number, default `200`)  
  Maximum lines returned by one ranged `read` on supported source.

## `context`

- `defaultBudgetTokens` (number, default `8000`)  
  Default token budget for [context.md](../graph/context.md) when the caller omits `budget`.

## Lifecycle

- Settings load on session start (and follow Tau extension settings load rules).

## Removed (do not carry forward)

- Entire `readGate` object (`includeGlobs`, `excludeGlobs`, anything gate-only)
- Any setting whose only consumer was `/read-stats`, locator behavior, or gate unlock

Full delete list: [stripped.md](../stripped.md).
