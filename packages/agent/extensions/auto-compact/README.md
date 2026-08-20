# Auto Compact

Compacts long conversations before the next model turn when their context reaches an absolute token limit. Active work resumes through a hidden continuation message after Pi's native compaction finishes.

Set `extensions.autoCompact.tokenLimit` to change the limit. It defaults to 175,000 context tokens for every model. Pi still shows its native collapsed compaction entry in the chat.

After changing this extension, run `/reload` before testing it.

Automatic compaction holds attention notifications while it runs and while the hidden continuation resumes the interrupted work. The notification is released only after that resumed work settles. It also pauses silent post-edit checks across the compact so they do not run on incomplete work.
