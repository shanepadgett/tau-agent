# Working Memory

Working Memory gives agent selective checkpoints without changing saved conversation.

`working_memory` keeps referenced user messages and visible assistant text. It has three file tiers:

- Auto-read full source into next turn when agent needs its body to decide, edit, or debug.
- Carry a structural outline when symbols and locations will support a later scoped read.
- Defer inactive files with reason and condition that makes them relevant again.

Use one tier for each path. `readFiles` publishes Tau's built-in autoread request; `outlineFiles` injects a structural outline; `deferFiles` records a conditional reminder.

`continuation` is a working note for next step: keep durable decisions, findings, unresolved questions, remaining work, and next action. It should carry enough reasoning to resume without rereading discarded results.

Automatic reminders begin at 40,000 active-context tokens and remain advisory. Run `/prune` to request reassessment manually.

Settings live under `extensions.workingMemory`.
