# Working Memory

Working Memory gives agent selective checkpoints without changing saved conversation.

`working_memory` keeps referenced user messages and visible assistant text, carries requested source files as structural outlines, and records deferred files as conditional reminders. Tool history and full file reads leave model context; useful findings from them are distilled into a compact continuation note.

Automatic reminders begin at 40,000 active-context tokens and remain advisory. Run `/prune` to request reassessment manually.

Settings live under `extensions.workingMemory`.
