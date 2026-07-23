# Context Pruning

Context Pruning removes old tool calls and their results from the messages sent to the model. It does not delete them from the saved conversation. Branch switching, transcript review, and normal Pi compaction still see the original records.

The feature can also remove old full-file autoread messages and old private reasoning. User messages, visible assistant prose, branch summaries, compaction summaries, shell records, and unrelated custom messages remain.

## The important distinction

Context usage and pruning are separate decisions.

- The context percentage decides when Tau gives the agent a pruning hint.
- A `context_prune` call decides what old evidence the agent wants to remove or retain.
- Tau then checks whether that exact removal is safe and whether it saves enough tokens.

Being at 70% context does not force Tau to apply a prune. The instruction tier depends on context growth since the latest successful anchor, and every prune still has to pass the checks below.

## What happens when the agent calls `context_prune`

The agent supplies three required lists:

- `keepFiles`: files whose complete current contents must remain available.
- `keepToolCalls`: exact earlier tool calls and results that must remain available.
- `deferFiles`: files that are currently irrelevant but may matter under a stated condition.

Unless retained by one of the first two lists, every complete earlier tool exchange and every autoread currently eligible for pruning is selected for removal. The current `context_prune` call is the anchor: later messages and tool results are unaffected by that anchor.

The agent is instructed to put durable conclusions, conditional information, and its next action in visible prose immediately before the call. That prose survives pruning. Tau enforces that `context_prune` is the only tool call in its assistant message, but it does not judge whether the preceding prose is complete or useful.

Tau prepares the result without changing the active context. It estimates the token count before and after the proposed removal, including any replacement file contents and deferred-file note. It applies the prune only when the estimated saving is at least `minimumReclaimTokens`.

After a successful call, Tau removes the selected evidence from future model input. The saved conversation remains unchanged. The tool result records exactly which tool exchanges and autoreads were removed, retained, or refreshed.

## Why a prune is skipped

A skipped prune removes nothing and publishes no deferred-file note or replacement file contents. Tau skips when any of these checks fails:

1. Context Pruning is disabled.
2. Tau does not have a usable copy of the exact messages most recently sent to the model.
3. The `context_prune` call is missing from the active branch.
4. Another tool call appears beside `context_prune` in the same assistant message.
5. The current model input contains duplicate, mismatched, or orphaned tool records that Tau cannot safely remove. An unmatched call from an explicitly aborted assistant response is discarded and does not block pruning.
6. A retained tool-call ID is duplicated, missing, or is not a complete exchange in the current model input.
7. Two selected file paths resolve to the same file, including aliases and symbolic links across `keepFiles` and `deferFiles`.
8. A retained file does not have an earlier complete-file read, has malformed read evidence, cannot currently be read as UTF-8, or exceeds the 1 MiB complete-file limit.
9. The estimated saving is below `minimumReclaimTokens`.

Cancellation, a session lifecycle change during preparation, and failures while publishing an already prepared prune are reported as tool failures rather than skipped prunes.

### “The latest provider-context projection is unavailable”

This error uses an internal term. In plain language, Tau did not have a usable copy of the exact message list the model had just received.

Tau normally saves that list while Pi prepares a model turn. Tau clears it on session start, branch changes, compaction, and shutdown. It also refuses to save a list with invalid tool-call/result pairing. If the list is missing or belongs to an earlier session state, `context_prune` stops before checking the agent’s selections or estimating savings.

Pi can save an aborted assistant response that requested a tool but never received a result. Tau discards that abandoned call when preparing later model input. Other unmatched calls and results still fail validation because Tau cannot prove whether their evidence is incomplete.

For example, a row that says `context_prune 29 selections` followed by this error means:

- the agent supplied 29 items across the three selection lists;
- Tau did not inspect or apply those selections;
- no old tool calls were removed;
- the context percentage did not cause the rejection;
- the current implementation does not reconstruct the missing list during that call.

The response tells the agent not to retry immediately because repeated calls in the same state would usually fail for the same reason. A later model turn should normally give Tau a new list. Repeated occurrences indicate a feature defect or a session history that Tau cannot safely process.

## Retaining files

`keepFiles` preserves complete current file knowledge, not necessarily the original read row.

Each selected file must have been read completely earlier in the current model input. A partial read is insufficient. Tau then reads the file from disk again and chooses the cheaper valid representation:

- Keep an existing complete snapshot when it still matches the file.
- Keep a baseline plus later read diffs when that chain reconstructs the current file and costs no more than a fresh snapshot.
- Add one fresh complete snapshot when the earlier evidence is stale, broken, or more expensive.

The entire prune is skipped if any selected file fails. Every retained file must currently exist, be valid UTF-8, and fit within the 1 MiB complete-file snapshot limit. Read the complete file before selecting it for retention.

Paths are resolved from the session working directory. Paths outside it are stored as absolute paths. Existing symbolic links and other aliases are resolved before duplicate checks.

The required `relevance` text explains the agent’s selection. It does not loosen any validation rule.

## Retaining tool exchanges

`keepToolCalls` retains both sides of an earlier exchange: the assistant’s tool call and the matching tool result. The ID must occur exactly once, the tool names must match, and the result must follow the call.

Retention is exact. Selecting one call does not retain nearby calls from the same assistant message. Tau can remove one parallel tool exchange while keeping another, then removes the empty assistant message if no content remains.

The required `relevance` text explains why the exchange matters. Tau does not use that text to infer additional exchanges to retain.

## Deferring files

`deferFiles` does not read or preserve file contents. It adds a hidden advisory note telling the model why each file was deferred and when to reconsider it. The latest successful anchor replaces the previous deferred-file list.

A deferred path may be missing. It still participates in canonical path and duplicate checks. Its `reason` and `relevantWhen` text are passed to the model as written.

## Automatic hints

Tau checks context usage only after a turn that produced at least one tool result. It emits at most one marker for the strongest newly crossed boundary.

With the defaults:

- `nudgeEveryPercent: 20` allows markers after enough context growth to cross 20% intervals.
- `nudgeInstructions` supplies three increasingly direct instructions. The first is informational, the second tells the agent to finish its current coherent step and move toward pruning, and the third tells it to prune before further tool work because stale managed context is wasting money.

The reminder number comes from context growth since the latest successful anchor. With the default interval, the three instructions apply at 20%, 40%, and 60% growth. If one turn crosses several boundaries, Tau emits only the strongest newly crossed reminder. After the final configured instruction, later boundaries repeat it. A hint never calls the tool or bypasses its checks.

The configured instruction is included verbatim in a fixed hidden protocol. That protocol tells the agent to keep context management private, preserve durable conclusions and the next action in visible prose, call `context_prune` alone, and avoid immediately retrying a skipped prune. At the final configured tier, the protocol also requires an anchor before further tool work. Reducing the instruction count therefore reaches mandatory pruning sooner.

After a successful prune, the first later tool-using turn records a new usage baseline and emits no automatic marker. Tau waits for context usage to grow by another `nudgeEveryPercent` from that baseline. The baseline, reminder tier, and crossed boundaries are stored with the active branch so compaction and branch navigation do not immediately repeat hints. If `nudgeEveryPercent` changes, existing boundaries remain crossed and future reminders use the new interval.

The visible marker is compact. The full instruction stays hidden, and the agent is told not to discuss internal context management.

## Manual requests

Run `/prune` with no arguments to ask the agent to create an anchor and continue unfinished work. The command starts an agent turn immediately. It does not force a successful prune or bypass file, tool-pairing, current-message, lifecycle, or minimum-savings checks.

Extra arguments produce `Usage: /prune`. When Context Pruning is disabled, the command reports that state and does not start a prune turn.

Asking the agent to prune in ordinary chat has the same execution boundaries once it calls `context_prune`.

## Branches, compaction, and display

Applied anchors belong to the active session branch. Switching branches rebuilds the removed-evidence set, deferred-file list, automatic-hint baseline, and warning-colored rows from that branch’s valid tool results. A skipped or malformed prune result does not become an anchor.

Context Pruning does not cancel or replace Pi’s manual, threshold, or overflow compaction. Compaction clears Tau’s saved model-input list; Tau must receive another model-input event before a later prune can use it.

Tau-owned tool rows and autoreads turn warning-colored when their evidence has been pruned. Native Pi rows and fallback rows that do not use Tau’s row-state renderer do not change color. Their evidence is still removed from model input.

## Settings

Settings live under `extensions.contextPruning` in Tau settings.

- `enabled`: enables the tool, `/prune`, automatic markers, branch replay, context filtering, and pruned-row display. Defaults to `true`.
- `nudgeEveryPercent`: integer context-growth interval between automatic hints. Allowed range: `1` through `100`. Defaults to `20`.
- `nudgeInstructions`: ordered list of one through five nonempty instructions, each at most 2,000 characters. Later reminders repeat the final instruction, whose fixed protocol requires pruning before further tool work. Defaults to three instructions escalating from informational at the first boundary to mandatory pruning at the third.
- `minimumReclaimTokens`: positive integer minimum estimated saving required to apply a prune. Defaults to `8000`.
