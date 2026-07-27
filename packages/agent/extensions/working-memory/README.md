# Working Memory

Working Memory gives agent selective checkpoints without changing saved conversation.

`working_memory` keeps referenced conversation evidence and complete tool exchanges, carries requested source files as structural outlines, and records deferred files as conditional reminders. Everything else before checkpoint leaves future model context.

Automatic reminders begin at 40,000 active-context tokens and remain advisory. Run `/prune` to request reassessment manually.

Settings live under `extensions.workingMemory`.
