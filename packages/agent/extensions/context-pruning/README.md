# Context Pruning

Context Pruning gives the agent direct control over its future model context. It does not delete or rewrite the saved conversation.

`context_prune` creates a hard checkpoint. Everything before that checkpoint leaves future model input unless the agent explicitly carries it forward. Messages after the checkpoint remain unchanged.

Before calling the tool, the agent writes visible prose containing the durable conclusions, user constraints, conditional relevance, and next action that must survive. That prose is part of the checkpoint turn.

## Selections

The tool accepts three required lists:

- `keepToolCalls` retains exact earlier tool exchanges by tool-call ID. Parallel calls remain independently selectable: retaining one call does not retain its siblings.
- `keepFiles` reads each selected file from disk and carries its complete current contents forward as a fresh autoread snapshot. Each successful snapshot appears as its own autoread marker below the compact checkpoint result. It does not require an earlier complete read.
- `deferFiles` carries forward a short advisory note explaining why a file is irrelevant now and when to reconsider it.

Duplicate selections are collapsed. A file selected in both `keepFiles` and `deferFiles` is kept. Missing, unreadable, or otherwise unsnapshotable files produce warnings in the successful tool result; they do not block the checkpoint or other file snapshots.

Context Pruning does not impose a minimum token saving and does not reject a checkpoint because old context has unusual bookkeeping. Pi supplies the current provider context. Tau removes unretained tool calls and their matching results with the same ID, drops other pre-checkpoint messages, and leaves the checkpoint turn and later messages intact.

## Automatic and manual requests

Tau checks context growth after tool-using turns and can send progressively stronger private instructions from `nudgeInstructions`. Growth is measured from the first tool-using turn after the latest checkpoint. Branch navigation and compaction reconstruct that baseline from the active branch.

Run `/prune` with no arguments to ask the agent to create a checkpoint and continue its task immediately.

## Branches, compaction, and display

Checkpoints belong to the active branch. Switching branches rebuilds the latest checkpoint, deferred-file state, automatic-hint baseline, and warning-colored pruned rows from that branch.

Normal Pi compaction remains independent. When a compaction no longer includes an old checkpoint turn, that checkpoint has nothing left to filter.

## Settings

Settings live under `extensions.contextPruning` in Tau settings.

- `enabled`: enables the tool, `/prune`, projection, markers, and branch replay. Defaults to `true`.
- `nudgeEveryPercent`: context-growth interval between automatic hints, from `1` through `100`. Defaults to `20`.
- `nudgeInstructions`: ordered list of one through five nonempty instructions. Later reminders repeat the final instruction. Defaults to three escalating instructions.
