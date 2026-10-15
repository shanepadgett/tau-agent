# Sidebar cache hit percentage

Status: built 2026-10-15.

The Context section shows the latest completed model call’s input and output token total against the context limit, a usage bar, and `Cache hit: 85.7%`. The context-usage percentage is omitted.

```text
cache hit % = 100 × call.tokens.cacheRead / call.tokens.input
```

Tau’s input total includes cache reads and writes. Output tokens do not enter the cache percentage denominator. This matches the measurement in Pi’s footer; Pi’s separate cached token counts must be added to its uncached input count. OpenCode’s Context sidebar does not show a cache-hit percentage.

| State | Cache line |
| --- | --- |
| No model call yet | Cache hit: — |
| Missing cache reads or missing/zero input total | Cache hit: unavailable |
| Explicit zero reads, positive input total | Cache hit: 0.0% |
| Partial/full cache hit | Percentage to one decimal place |
| Streaming call | Previous completed call’s value |
| Reopened session | Latest available saved call, through history replay |

`src/core/internal/loop/reply.ts` already saves the counts; `ModelCall` carries them to the TUI. `src/tui/internal/chat-state.ts` keeps the latest cached-input share in `Usage.cacheHitShare`. `src/tui/internal/SessionPanel.tsx` formats it. No new event or persistence field is needed.

Reducer tests cover the denominator, unavailable counts, replacement and replay. Terminal tests cover the empty state, explicit miss, replayed partial hit, unavailable reporting and removal of the context percentage.
