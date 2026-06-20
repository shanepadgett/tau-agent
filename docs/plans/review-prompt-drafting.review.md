# Review: `/review` new-chat prompt drafting

## Files
- `src/extensions/soul/postures.ts` — new `draftReviewKickoffPrompt`, transcript/evidence formatting, `messageText`, `cleanDraftPrompt`, fallbacks
- `src/extensions/soul/README.md` — updated review helpers description

## Verdict
Clean. Ship. One minor finding.

## Findings

### `src/extensions/soul/postures.ts`:L686 — unchecked error stop reason

`completeSimple` returns an `AssistantMessage` with `stopReason` that can be `"error"` or `"aborted"`. The stream protocol encodes errors in the returned message, it does not throw. `draftReviewKickoffPrompt` only catches thrown errors (e.g. no provider registered). If the model returns `stopReason === "error"`, `messageText(response)` extracts whatever partial/empty text exists, then `|| fallbackReviewKickoff(focus)` silently substitutes the fallback. User gets no notification that the model failed — just the generic prompt.

Compare `src/shared/model-fallback/index.ts`:L103-L108 which explicitly checks `response.stopReason === "aborted"` and `"error"`.

Smallest fix: after the `completeSimple` call, check `response.stopReason`:

```ts
if (response.stopReason === "error" || response.stopReason === "aborted") {
    ctx.ui.notify(`Review prompt draft skipped: ${response.errorMessage ?? response.stopReason}`, "warning");
    return fallbackReviewKickoff(focus);
}
```

Low severity — degrades gracefully, just silently. Worth fixing for the user feedback.

## Notes (no action needed)
- `messageText` duplicates text-extraction logic from `model-fallback/index.ts`. Both are small and local; not worth extracting to shared.
- `reasoning: "minimal"` and `temperature: 0` are valid `SimpleStreamOptions` fields. Provider compat flags handle models that reject temperature.
- Transcript sends prior chat text to the chosen review model. Same provider the user is already using, or one they explicitly picked. No new exposure.
- `MAX_REVIEW_PROMPT_EVIDENCE_CHARS = 50_000` truncates evidence for the draft input while the injected evidence in the new chat keeps the full 80k. Correct — draft only needs to summarize.
- `setEditorText` + notify replaces `sendUserMessage`. Correct behavioral change — user can edit before submitting.
- `mise run check` passes clean.
