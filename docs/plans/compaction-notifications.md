# Compaction notifications

Status: implemented; awaiting live verification after `/reload`.

## Goal

Preserve the serialized conversation prefix when a context threshold is crossed. Make notice informational, warning a request to compact soon at a safe boundary, and forced the existing hard tool cutoff.

## Findings

- Tau currently appends mutable guidance through `context` in `packages/agent/extensions/compaction/self-compact.ts`.
- Pi 1.1.0's `restoreSystemMessages()` collapses historical system messages into a leading prompt whenever a `context` handler changes the conversation list, including appending one message. This rewrites the provider request prefix.
- The latest worktree session's cache diagnostics recorded `instructions` changes and cache reads falling to 4,096 tokens at 04:56:40 and 05:14:39 UTC on 12 October 2026, before self-compaction.
- Guidance is regenerated with current token counts on every request. Earlier guidance is removed instead of retained ahead of the model response it produced.
- The notice says to compact before substantial further work, including before implementation. Permanent context-management guidance also tells the agent to compact when guidance appears, without distinguishing stages.

## Architecture

Modify the existing compaction extension. Add no new subsystem and make no changes to Pi, Soul, model routing, or settings thresholds.

Use journaled `tau.compaction.guidance` custom messages for threshold delivery. Emit each newly reached severity once in the current compaction epoch. Keep the message's text, token count, thresholds, and position immutable afterward. Escalation appends a new message; it never edits the old one.

Use Pi's supported append boundaries:

```text
New user run / resume
  before_agent_start
    refresh settings, restore committed compaction state
    compute current level
    return one missing threshold message
  Pi journals that message with the new prompt

Active run
  assistant response -> tool results -> turn_end
    compute current level
    return missing threshold message as a boundary draft
  Pi journals the message after the completed turn
  natural next request includes that message in the transcript

Natural run completion at warning / forced
  agent_before_settle
    preserve the existing one-reminder-per-cycle continuation
    append a separate immutable reminder

Successful checkpoint
  existing compaction entry replaces the old context
  notification history in the replaced epoch no longer applies
```

Notice and warning threshold delivery do not request another model turn. A final answer must not cause an extra run solely to deliver an informational notice. Forced tool blocking and the existing warning/forced settlement reminder remain in place.

Retain the `context` handler only for observing committed checkpoint state, clearing progress, and publishing footer state. It must return no replacement messages and must not mutate `event.messages`. This avoids Pi's collapse path without taking ownership of system-message restoration through `context_with_system`.

## Notification state

Use committed guidance messages as the notification ledger rather than adding another boolean to `State`.

Threshold message metadata:

```ts
type GuidanceStage = "notice" | "warning" | "forced";

type GuidanceDetails =
  | { kind: "threshold"; level: GuidanceStage }
  | { kind: "settlement-reminder"; level: "warning" | "forced" };
```

Derive the highest delivered threshold from projected custom messages in the active epoch. For a boundary, inspect `event.context.contextMessages`, which includes proposals from preceding handlers. For run start, inspect `buildSessionProjection().messages`.

Emit only when the current severity exceeds that recorded severity. If usage jumps directly to warning or forced, emit that stage alone. Do not replay lower stages if usage later falls or the model changes. A smaller model window may require escalation; forced remains latched by the existing compaction state.

Resume, reload, and tree navigation derive delivery from their own committed branch. Merely preparing a draft does not mark a notification delivered. Cancelled or rejected drafts remain eligible next time. Legacy guidance without stage metadata stays untouched; only new threshold messages establish the delivery ledger.

Keep the existing `nudged` and `forced` fields for their existing settlement and enforcement behavior. Preserve pending, failed, and ready compaction recovery. No notification is emitted while a handoff is pending or compaction is running.

## Code boundaries

Keep one shared draft builder inside `registerSelfCompaction`, used by the two delivery entry points:

```ts
nextGuidance(
  current: Level,
  messages: readonly AgentMessage[],
): CustomMessageEntryDraft | null
```

The callers check for substantive material through the existing guard. The builder narrows to an enabled threshold stage, compares committed severity, and constructs bounded text using the existing prompt templates. It has no persistence side effects.

`before_agent_start` returns `BeforeAgentStartEventResult.message` from the draft's custom message fields. `turn_end` returns `BoundaryResult.entries: [draft]` only for a completed, uncancelled turn. Neither requests continuation for ordinary threshold delivery.

Update these existing paths in `self-compact.ts`:

- `guidance()` remains template rendering, called only for new messages or the existing settlement reminder.
- `before_agent_start` refreshes settings, reconciles committed compaction state, publishes the level, and supplies missing guidance.
- `turn_end` publishes the level and proposes missing guidance after tool results.
- `context` no longer filters, regenerates, or appends guidance.
- `agent_before_settle` records the reminder's separate metadata and retains its existing continuation guard.
- Permanent context-management instructions distinguish notice, warning, and forced. Handoff format and the `self_compact` tool contract remain intact.

The existing summary builder already excludes `tau.compaction.guidance`. Keep that exclusion: notifications inform the active agent but do not become durable checkpoint content.

Pi 1.1.0 is both the installed development version and the declared peer minimum. Its `before_agent_start` custom message return and boundary drafts support this design. No minimum increase or compatibility branch is needed.

## Stage wording

| Stage | Intended instruction |
| --- | --- |
| Notice | Informational. Continue active work; do not interrupt implementation, debugging, or validation solely because of this notice. Compaction is not required yet. Do not compact just to send a final answer. |
| Warning | Context is getting short. Finish the current bounded work unit, then compact before beginning another substantial unit. Do not abandon an in-progress operation. If only the final answer remains, send it; the existing settlement reminder handles remaining context management. |
| Forced | Only `self_compact` is allowed. Save the current handoff and compact now. |

Keep current token and threshold values in each notification as a snapshot, not a live counter. Keep the handoff field requirements, character guidance, and continuation instructions in warning/forced and permanent guidance; remove the handoff-writing assignment from notice.

Update the compaction extension README and the compaction section of `tau-help/help.md` to describe the distinct stages and one-time escalation messages.

## Cache requirements

Before compaction, the fields allowed to change because of a notification are new trailing conversation messages and the provider's normal trailing cache-marker/effort placement. Notification delivery must not alter leading `system`/`instructions`, tool declarations, earlier prompt-update messages, or earlier conversation content.

Validate consecutive requests after all Pi transformations and provider serialization:

1. Below notice: existing prompt and tool-update history is preserved.
2. First notice: only a new trailing notification appears; the request envelope stays stable.
3. Same stage: notification remains ahead of the response it produced, with identical content and metadata; no replacement notification appears.
4. Warning/forced: only a new trailing stage message appears; old notifications remain unchanged.
5. Reload/resume/tree switch: the committed active branch controls delivery, with no duplicate stage or accidental prompt collapse.
6. Successful checkpoint: the intentional history replacement starts a new epoch; ordinary notification delivery does not cause that replacement early.

For Anthropic, account for the normal relocation of the terminal `cache_control` and managed-effort blocks when comparing payload fingerprints. Do not mistake those trailing changes for changes to substantive historical content. For Codex, require stable `instructions`, tool declarations, and historical input hashes.

## Verification and rollout

Use in-memory lifecycle and provider serialization exercises to cover delivery, escalation, final-answer settlement, and committed-state recovery. Add or update no repository tests. Then run the required repository checks.

Live behavior requires the user to `/reload` after implementation. Inspect cache diagnostics on actual threshold crossings to confirm stable request envelopes and preserved historical content. Assess whether the model continues active work at notice and reaches warning naturally; wording compliance cannot be established from payload checks alone.

### Completed verification

In-memory exercises ran the production extension handlers with Pi's real session projection and context runner. They verified one-time escalation, retry eligibility for uncommitted drafts, informational notice without continuation, reload and tree-branch recovery, checkpoint epoch reset, the settlement reminder guard, and forced tool blocking.

Anthropic and Codex provider serializers captured requests before any network operation. Consecutive below-threshold, notice, same-stage, warning, and forced requests preserved the request envelope and substantive historical prefix, including historical system updates. Cancelled turns proposed no notification. Live cache hit rates and model behavior remain unverified until reload and actual threshold crossings.

## Approved decision

Journaled one-time threshold delivery, informational notice, and safe-boundary warning are approved. Retain the existing forced cutoff and warning/forced settlement reminder.
