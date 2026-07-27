# Explore settings

## Extension key

- `explore`

## `read`

- `enabled` (boolean, default `true`)  
  Master switch for Explore’s structural read overlay and large-source autoread outline path ([read-policy.md](read-policy.md), [autoread.md](../session/autoread.md)). When `false`, Pi `read` and autoread use ordinary full/ranged bodies — no outline substitution, no Explore `maxRangeLines` enforcement.
- `structureThresholdLines` (number, default `200`)  
  Supported source files at or under this line count may be full-read via Pi `read`. Above it, a full read’s model-visible result is outline only ([read-policy.md](read-policy.md)). Ignored when `enabled` is `false`.
- `maxRangeLines` (number, default `200`)  
  Maximum lines returned by one ranged `read` on supported source (enforced by Explore overlay if Pi does not). Ignored when `enabled` is `false`.

## `context`

- `defaultBudgetTokens` (number, default `8000`)  
  Default token budget for [context.md](../graph/context.md) when the caller omits `budget`.

## Lifecycle

- Settings load on session start (and follow Tau extension settings load rules).

## Removed (do not carry forward)

- Entire `readGate` object (`includeGlobs`, `excludeGlobs`, anything gate-only)
- Any setting whose only consumer was `/read-stats`, locator behavior, gate unlock, or complete-file body cache

Full delete list: [stripped.md](../stripped.md).
