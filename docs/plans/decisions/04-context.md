# 04 Context management (self-compaction)

## Status

The initial implementation is wired and passed repository checks. Live use confirmed the hidden answer-first reminder, context guidance, self-compaction, verbatim note recovery, and routing after compaction.

The unified checkpoint, zero retained conversation, animated progress widget, and three-row footer are now implemented. Repository verification and live validation are tracked separately; the provider-payload, lifecycle, and layout checks below still require `/reload` and live use.

Focused in-memory probes confirmed one successful summary request, canonical context edits/omissions, verbatim handoff assembly, zero-retention projections for self/manual/threshold/overflow paths, journal-confirmed unlocking, pending-handoff reload recovery, native fallback delivery and warning, loader lifetime through commit/cancellation, and footer widths from 20 to 240 columns. These probes injected the summary response and routing boundary; they do not establish actual provider payloads, classifier accuracy, model-switch commits, or live timing.

## Goal

The agent chooses when to compact, with notice, warning, and forced thresholds as guardrails. Compaction replaces the entire active conversation with one checkpoint: useful background plus an exact current handoff. The user sees an animated working indicator throughout self-compaction.

Old messages stay in the session transcript on disk for recovery. They do not stay in the model's next request. System instructions, tool definitions, and the checkpoint itself still occupy context.

## Agreed direction

- Keep `self_compact`, fixed thresholds, and the warning-level follow-up. No decision-model checkpoint detector and no `view_context` tool.
- Use one checkpoint format for self-compaction, `/compact`, threshold compaction, and overflow recovery.
- Retain no preceding conversational messages after a successful Tau checkpoint. Remove the default approximately 20,000-token recent-history tail, including the original note tool call and its result.
- Preserve the agent's handoff word for word, once inside the checkpoint. This replaces the earlier design that delivered the full note as a separate hidden message.
- The handoff covers current work and the next action, not a second history summary. Aim for 500–1,500 characters when possible. Keep the existing 24,000-character safety limit; it is not a target and notes are never truncated silently.
- Summarize the complete canonical projected history in one successful model request, rather than splitting history and a turn prefix into separate summary calls.
- Show animated self-compaction progress near the chat, above the editor. Do not use a footer `COMPACTING` label as the working indicator.
- Expand the footer to three rows, move branch information to the bottom left, show decision-model status beside the main model, and remove the input/output/cache-read/cache-write token counters.
- Use the reference's distinct context-bar symbols and 20 cells.

## Reference and live evidence

The reference is `disler/self-compact-pi-agent`, commit `576fe4a`, cloned at `/private/tmp/self-compact-pi-agent`.

Its `self_compact` tool saves a note, then invokes `ctx.compact()`. A separate summarizer produces a history summary, and the note is returned verbatim afterward. Both its summary prompt and Tau's initial prompt say not to reproduce the note, but their requested facts overlap. Retaining recent history can also keep the original note tool arguments alongside the returned copy. The reference delegates summary generation to Pi's `compact()` helper, which can make separate history and split-turn summary calls.

Tau's first live self-compaction had a 12,304-character note, a 16,403-character summary, a retained original note tool call, and a separate returned note. It used the split-turn summary path. Context fell from 167,012 tokens to about 46,905; that is evidence of a working handoff, not a measured before/after latency comparison.

## Architecture

This modifies the existing `compaction` and `footer` extensions and their integration with `decisions`. It adds no extension or separate checkpoint service.

### Checkpoint ownership

| Section | Owns | Does not own |
| --- | --- | --- |
| Durable context | Overall goals, standing constraints, important historical decisions, useful verified results, and file/transcript references | Current task status, immediate blockers, outstanding questions, or the next action already covered by the handoff |
| Current handoff | Current request and its authorization limits, unfinished work, immediate blockers, unanswered questions, and exact NEXT ACTION | A comprehensive done-work list or implementation recap |

The agent supplies the handoff for `self_compact`. Without an agent handoff, the summarizer writes both sections from the projected conversation. This includes manual and emergency compaction and `/compact` recovery of a pending note.

The summary prompt explains these ownership rules. When an agent handoff is supplied, the model returns no generated handoff; assembly inserts the supplied text verbatim. Prompt instructions reduce semantic overlap, but live review must still check the resulting sections. There is no reliable generic string filter for duplicated meaning.

```text
self_compact(note_to_self)
  → persist handoff + tool-call ID, block siblings, terminate batch
  → agent_before_settle
      → show animated loader
      → build full canonical history; exclude this note call/result
      → generate durable context in one request
      → assemble checkpoint with verbatim handoff
      → route on handoff; await model/thinking commit
      → stage zero-retention compaction + short continuation + unlocked state
      → confirm journal commit, clear loader
      → continue from checkpoint's NEXT ACTION

/compact / threshold / overflow
  → Pi's native compaction indicator
  → session_before_compact
      → build the same full canonical history
      → generate durable context and handoff, or use pending agent handoff
      → assemble the same checkpoint
      → create an invisible retention anchor; return compaction result
  → session_compact
      → route on checkpoint handoff; await model/thinking commit
      → unlock pending handoff and resume when required
  → Pi clears its native indicator
```

### Types and code boundaries

Pseudocode; production declarations belong in the existing compaction files, not a new public API:

```ts
type AgentHandoff = {
  id: string;
  toolCallId: string;
  text: string;
};

type CheckpointInput = {
  messages: AgentMessage[]; // Complete canonical projection, including prior summary.
  agentHandoff: AgentHandoff | null;
  customInstructions: string | null;
};

type GeneratedParts = {
  durableContext: string;
  handoff: string | null; // Null when the agent already supplied it.
};

type Checkpoint = {
  summary: string; // Durable context followed by exactly one current handoff.
  handoff: string; // Routing input; not a second model-visible message.
  usage: Usage;
  details: {
    checkpointId: string;
    handoff: string; // Private recovery/routing metadata; not serialized to the model.
    readFiles: string[];
    modifiedFiles: string[];
  };
};
```

- **`self-compact.ts`:** keep the branch-local state machine and saved handoff. Record the accepting tool-call ID to exclude only that call/result from summary input. Replace recent-tail preparation with full projected-history preparation. A session containing only an existing checkpoint has nothing new to compact; do not strand it behind a tool lock.
- **`summary.ts`:** replace Pi's split-turn `compact()` generation path with one full-history checkpoint request. Reuse same-provider quick-effort candidates, then the session model. Use `modelRegistry.streamSimple(...).result()` with the existing reasoning, cancellation, and uncached-summary policy. Serialize projected messages through Pi's conversion/serialization APIs, preserving context edits and omissions. Do not separately add the prior summary when it is already in that projection.
- Request structured `GeneratedParts`, validate complete successful output, and assemble the checkpoint deterministically. An agent-supplied handoff requires a null generated handoff; absent agent input requires a nonempty generated handoff. Empty, malformed, refused, aborted, or length-stopped output is not a valid checkpoint. Maintain bounded output and input-window checks, including serialization overhead.
- Preserve file-operation tracking across checkpoints and new source messages. Prefer references for rereadable implementation detail, rather than copying entire implementation descriptions into the checkpoint.
- **`index.ts`:** register the compaction lifecycle. Native handlers live beside the branch-local handoff state in `self-compact.ts` so both entry paths use the same checkpoint builder, not the native preparation's already-split message subsets. Carry checkpoint handoff metadata to `session_compact` so routing does not classify the entire historical summary.
- **Routing:** retain `tau:compaction.handoff` and its `{ note, ctx, signal, waitFor }` payload. `note` now means the checkpoint's current handoff. Keep the 3-second classifier deadline, subscription-only model selection, explicit-model protection, and awaited model/thinking commit before continuation.

### Zero retention at the Pi boundary

Pi 1.1.0 is the supported minimum; do not raise it for this revision.

- **Self-compaction:** `CompactionEntryDraft.firstKeptEntryId: null` explicitly creates a self-retaining compaction that keeps no preceding entries. Use that documented boundary contract.
- **Manual/threshold/overflow:** `SessionBeforeCompactResult.compaction` still uses `CompactionResult`, whose `firstKeptEntryId` is a required string. Do not cast null through that type or depend on the default cut-point algorithm keeping nothing.
- After successful checkpoint generation, synchronously append a private, non-model-visible custom anchor, obtain its ID through `ctx.sessionManager.getLeafId()`, and return that ID as `firstKeptEntryId`. The anchor is the last entry before the compaction and carries no model message, so no earlier conversation is retained. Narrow the returned ID; do not use a non-null assertion.
- Keep this adaptation at the compaction integration boundary. The checkpoint builder does not know whether the caller uses a nullable boundary draft or a typed native result.
- A continuation message contains only a short instruction to resume from the checkpoint's NEXT ACTION. It does not repeat the handoff. Manual `/compact` without pending work does not manufacture an autonomous continuation; overflow preserves Pi's retry behavior.

### Commit, recovery, and failure

- Self-compaction remains in `agent_before_settle`; `agent_settled` is notification-only, and `ctx.compact()` aborts the active run.
- Treat the checkpoint as successful only after it is journaled. Use checkpoint ID metadata to recover a committed handoff without summarizing it again or adding another copy. Retire recovery checks that depend on a full separate `tau.compaction.note` message being present.
- Preserve the note and lock on cancellation or summary failure. Retain the existing bounded retry policy; no background retry after cancellation or shutdown. A subsequent run or `/compact` can recover.
- Never remove raw history before a complete valid checkpoint exists. An uncommitted invisible anchor is harmless if cancellation occurs before native compaction commits. Append the anchor only after a valid checkpoint exists, so a failed Tau checkpoint leaves no anchor in front of Pi's fallback.
- **Agreed fallback:** when Tau's checkpoint fails for `/compact`, threshold, or overflow compaction, keep Pi's default compaction as the safety net. That compaction retains Pi's recent raw tail and uses Pi's summary format, so it is the one exception to zero retention; the next Tau checkpoint clears the tail. A pending agent handoff is delivered separately after a Pi fallback, as in the initial implementation. Show a warning notification when the fallback runs, for example `Tau checkpoint failed; used Pi compaction, recent history retained.` Overflow recovery depends on this fallback, because failing without compacting would leave the session unable to send its next request.
- Self-compaction has no Pi fallback. After its bounded retries fail, it keeps the handoff and lock and shows an error; the next run or `/compact` retries.

## Visible progress

Self-compaction owns a non-blocking `ctx.ui.setWidget()` above the editor, using Pi TUI's `Loader` and the active theme. Its stages are `Compacting context…` during summary generation and `Preparing handoff…` during routing/commit. It remains visible until journal commit or failure, rather than disappearing when the note-saving tool returns.

Use the loader's normal animation. Widget disposal calls `loader.stop()`. Completion, cancellation, session shutdown, and tree switches remove the widget and stop its timer. A failure clears animation and produces a visible error notification while preserving the pending handoff. Width handling follows Tau's TUI rules; the widget does not take focus or introduce hardcoded keybinding hints.

Manual, threshold, and overflow compaction already have Pi's native indicator; keep that indicator rather than showing a duplicate widget. The footer retains context-level information but is not the place to announce ongoing compaction.

## Three-row footer

| Row | Left | Right |
| --- | --- | --- |
| Top | Auto route, model, thinking level, classifier as provider/model (same dim style) or availability status | Context bar, latest cache-hit rate, session and daily cost |
| Middle | Working directory and session name | Other extension statuses |
| Bottom | Git branch and change counts | Other footer items |

- Remove `↑`, `↓`, `R`, and `W` token counters from rendering. Keep the underlying accounting needed for cache-hit rate and costs.
- Move the existing decisions status out of the generic extension-status list into the top-left group without displaying it twice. Use existing route/compaction events and refresh paths; do not add a second classifier call just to populate the footer.
- Use a 20-cell context bar: `•` cached context, `·` other used context, `-` free; `?` notice, `!` warning, `|` forced. Hide the context percentage and window total. Stronger markers win collisions. Clamp cached share to used context and distinguish unknown usage from zero. Color only dots: through `?` with theme success (green), after `?` through `!` with warning (yellow), and after `!` with error (red). All other bar characters and level tags stay gray. Apply column-aware width handling.
- Reuse the existing split-row renderer for all three rows. On narrow terminals, preserve the context/cost group while shortening left-side text; every row must fit the available width.
- `compaction` continues emitting `tau:compaction.level` with `{ level, tokens, thresholds }`. Live token counts stay out of static prompt contributions.

## Prompts and settings

Prompts remain built in under `extensions/compaction/prompts/`; no user override files. Rewrite notice/warning/forced guidance and tool descriptions to request a short current handoff and explain that it is preserved once inside the checkpoint. Rewrite the summary prompt for the ownership rules and complete-history input.

```jsonc
"compaction": {
  "selfCompact": {
    "enabled": true,
    "noticeTokens": 100000,
    "warningTokens": 150000,
    "forcedTokens": 200000
  }
}
```

Keep the agreed settings and thresholds. Cap each threshold below 90% of the model window and below Pi's own compaction threshold. At forced level, block every tool except `self_compact`. A run ending at warning/forced gets one hidden compaction nudge per cycle.

Zero raw-history retention is the Tau checkpoint policy, not another opt-in flag or a change to the user's Pi settings file. Disabling `selfCompact.enabled` disables proactive guidance/tool-driven compaction, not the checkpoint format used by native compaction triggers.

## Cache and verification

Before implementation, identify final serialized request changes: conversational messages become the checkpoint plus a short continuation, while system instructions and tool schemas keep their stable prefix. This reset is intentional at compaction. Subsequent requests must preserve the unchanged checkpoint prefix; mutable threshold guidance stays at the tail. UI widgets and footer changes must not add model-visible messages.

After implementation and user `/reload`, verify final provider payloads, not just intermediate projection:

1. The checkpoint appears once; its handoff matches the saved input verbatim. None of the preceding user/assistant/tool-result messages or original note arguments remain active.
2. A normal successful checkpoint uses one summary-model request, including cases that previously split a turn. Candidate failures/retries are reported separately from that successful-request count.
3. Manual, threshold, overflow, and self-compaction all use the same format and contain the most recent user request, authorization limits, unresolved questions, and actual pending next action.
4. Reload/tree/cancellation recovery preserves the pending or committed handoff without reintroducing raw history or duplicating continuation.
5. Routing respects explicit model choice, and the next request uses the committed model/thinking pair.
6. The loader stays visible through summary and handoff, stops on all exit paths, and manual compaction does not gain a second spinner.
7. All three footer rows fit narrow and wide terminals, decision status appears once, costs include decision calls, and each threshold has its distinct marker.
8. Inspect consecutive final provider requests for stable checkpoint/system/tool fingerprints. Compare elapsed time and actual token usage with the earlier live compaction; do not infer savings from character counts alone.

No new repository tests or fixtures. Reuse the existing spike harness, read-only session inspection, live use, and required repository checks. Update compaction/footer READMEs and `tau-help` together with user-facing changes. Regenerate any settings schema through the existing extension if settings actually change; do not edit it manually.
