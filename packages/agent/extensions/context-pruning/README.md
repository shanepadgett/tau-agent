# Context Pruning

Context Pruning removes stale tool evidence from the context sent to the model while leaving the session transcript intact. The agent can create a prune anchor after broad exploration has converged or enough irrelevant evidence has accumulated.

Before calling `context_prune`, the agent records durable conclusions and its next action in visible prose. It can retain exact tool exchanges, retain current knowledge of selected files, and defer files until a stated condition applies. The tool prepares any required file snapshots before applying the anchor, skips attempts with low estimated savings, and continues the current agent run automatically.

After tool-using turns, Tau occasionally adds a compact context marker. At lower usage it is informational. Under pressure it asks the agent to finish a coherent step and prune only when the savings are worthwhile. The full steering text stays hidden, and the agent is told not to discuss context management.

Run `/prune` with no arguments to ask the agent to create an anchor and continue its unfinished work. The same validation and minimum-savings rules still apply, so a low-value attempt is skipped.

Prune anchors, automatic marker boundaries, and warning-colored Tau tool rows follow the active session branch. Switching branches restores that branch's state. Pi's manual, threshold, and overflow compaction continue to work normally.

Manual UI check: Tau-owned tool rows and autoreads should turn warning-colored when pruned. Native Pi rows and fallback rows that don't use Tau's row-state renderer won't change color; pruning and read-cache behavior still apply to them.

## Settings

Settings live under `extensions.contextPruning` in Tau settings.

- `enabled`: enables the tool, `/prune`, automatic markers, branch replay, context projection, and pruned-row display. Defaults to `true`.
- `nudgeEveryPercent`: context-growth interval between automatic markers. Defaults to `20`.
- `pressurePercent`: usage above which a marker suggests pruning after the current coherent step. Defaults to `50`.
- `minimumReclaimTokens`: minimum estimated saving required to apply a prune. Defaults to `8000`.
