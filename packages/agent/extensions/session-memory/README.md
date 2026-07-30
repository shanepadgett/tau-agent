# Session Memory

Session Memory keeps one bounded state snapshot for long agent runs: an optional long-term goal, active tasks, short-term and long-term memories, and active files.

The agent uses `session_memory` to replace that snapshot. Every successful call returns the full current state. Most work leaves the long-term goal empty. The agent uses one when work needs durable direction across many tasks or checkpoints that tasks alone cannot capture, and changes it when that direction changes. Memory IDs stay stable across edits and when moving from short-term to long-term memory. File tiers form the restore manifest for the next checkpoint: reads need exact contents, outlines need structural context, and deferred files stay unloaded until their recorded condition applies. Ordinary updates save this manifest without loading files.

Tasks contain only ordered unfinished work, with current task first. The agent removes completed or abandoned tasks immediately and reconciles changed state before its final response. After ten successful non-memory tool results without an update, the next model request gets a hidden reminder to review tasks; the reminder disappears after a valid update.

Short-term memory survives one checkpoint span. Long-term memory remains until the agent removes it.

At fixed token gates, the extension asks for review and eventually blocks other tools until `session_memory` completes a required update. Checkpoints replace old model context with the saved snapshot, current contents of requested read files, and fresh requested outlines. Saved transcript and branches remain intact.

Run `/prune` to request an update and checkpoint. Run `/session-memory` to open the session-memory panel. Use Left and Right to switch between tasks, memories, and files; press Escape to close it.

`session_memory` tool rows are hidden by default. Set `extensions.sessionMemory.showToolRows` to `true` in global or project Tau settings to show them for debugging.
