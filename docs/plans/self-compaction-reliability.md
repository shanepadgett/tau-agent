# Self-compaction reliability

Implementation authorized by the user on 13 October 2026.

## Architecture

Expand Tau's self-compaction summarizer; reuse Pi's public `generateSummaryWithUsage` for serialization, summary generation, transient retries, and cache-disabled requests. Keep same-provider quick-model selection independent of native/self-compaction. Native compaction continues using `compact` and its existing retained boundary.

Self-compaction continues summarizing only canonical projected history, replacing all raw history, and inserting the saved handoff verbatim once. The checkpoint writer retains ownership of JSON validation, cumulative file lists, and handoff assembly.

## Call path and boundaries

```text
agent_before_settle
  -> summarize(projectedMessages, savedHandoff, ctx, signal, pi)
     -> resolveCompactionCandidates(ctx)
     -> for each same-provider model:
        generateSummaryWithUsage(history, model, reserveTokens, ...,
          customInstructions, undefined, thinkingLevel, streamFn, ..., retrySettings)
          -> streamFn(model, finalContext, options)
             -> validate final serialized input/output window budget
             -> ctx.modelRegistry.streamSimple(...)
             -> capture terminal response metadata
        validate JSON and durable-context size
        on length/oversize: regenerate from full input with a smaller target
        on other failure: try the next candidate
     -> assemble durable context + file lists + verbatim handoff
  -> route handoff
  -> propose retain-none checkpoint, continuation, and unlocked state
```

Durable-context limits are 8,000, 4,000, then 2,000 characters. Never truncate a response or accept a length stop. Compression retries happen on the cheaper candidate before session-model fallback. Pi's configured retry policy replaces the outer identical retry loop. Failed/cancelled checkpoints retain the saved handoff and tool lock; `/compact` recovery remains intact.

`pi.appendEntry("tau.compaction.failure", metadata)` records fixed-size diagnostic fields: model, stop reason, token usage, text/thinking lengths, input estimate, output budget, and compression limit. It never records prompts, handoffs, response text, or provider error bodies.

## Cache and verification

Only helper summary requests change: Pi disables their cache writes. Within a compression retry, the serialized conversation stays unchanged and changing instructions appear after it. Failure diagnostics are non-context custom entries. The main-agent boundary, prompt append behavior, and verbatim handoff remain unchanged.

Use offline in-memory model streams through the same `streamFn` boundary to inspect final requests and exercise compression, transient retry, fallback, validation, cancellation, and retain-none assembly. Do not add or modify tests, send live model requests, or change Pi minimums. The installed and minimum Pi version is 1.1.0; its root exports include `generateSummaryWithUsage`. Run repository checks after implementation and offline verification. Live testing requires `/reload`.

## Implemented and verified offline

The public Pi generator now owns transient retries; the outer identical retry loop is removed. Compression retries retain the same conversation and saved handoff, with the changing size instructions last. Bounded failure entries include reasoning-token usage when reported, otherwise `null`, plus thinking character counts without storing content.

In-memory streams exercised cheap-model compression, oversize rejection, configured transient retries, same-provider fallback, invalid JSON and extra-key rejection, window-budget rejection, cancellation, cumulative file lists, and verbatim handoff assembly. The actual settlement handler proposed a retain-none checkpoint and unlocked tools only after persistence. Native `/compact` kept its recent boundary and separately delivered a pending handoff after failed self-compaction. Offline Anthropic serialization confirmed the final output budget, disabled cache writes, and an unchanged conversation/handoff prefix across compression retries; no network requests were sent.
