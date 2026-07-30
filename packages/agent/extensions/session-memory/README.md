# Session Memory

Session Memory keeps one bounded state snapshot for long agent runs: goal, current objective, tasks, memories, and active files.

The agent uses `session_memory` to replace that snapshot. Every successful call returns the full current state. Memory IDs stay stable across edits and promotion from carry to durable memory. File tiers form the restore manifest for the next checkpoint: reads need exact contents, outlines need structural context, and deferred files stay unloaded until their recorded condition applies. Ordinary updates save this manifest without loading files.

Tasks contain only ordered unfinished work, with current task first. The agent removes completed or abandoned tasks immediately and reconciles changed state before its final response. After ten successful non-memory tool results without an update, the next model request gets a hidden reminder to review tasks; the reminder disappears after a valid update.

Carry memory survives one checkpoint span. Durable memory remains until the agent removes it.

At fixed token gates, the extension asks for review and eventually blocks other tools until `session_memory` completes a required update. Checkpoints replace old model context with the saved snapshot, current contents of requested read files, and fresh requested outlines. Saved transcript and branches remain intact.

Run `/prune` to request an update and checkpoint. Run `/session-memory` to open the session-memory panel. Use Left and Right to switch between tasks, memories, and files; press Escape to close it.
