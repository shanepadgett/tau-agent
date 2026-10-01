# Soul

Soul supplies Tau's system prompt: communication, discussion, planning, execution, coding, and tool-use guidance. It is always on.

The agent uses dedicated tools first for ordinary reads, searches, and edits. Bash handles shell commands such as builds and tests. Scripts are reserved for work the available tools cannot reasonably handle, or substantial bulk transformations and computation that would otherwise require many repetitive or error-prone calls. A shorter script alone is not a reason to replace a dedicated tool.

Soul adds Pi documentation pointers, tool guidance, and the context that other Tau extensions supply, such as the local date, directory snapshot, and automatic-check instructions. The date and directory snapshot are captured on the first prompt and again after successful compaction, so they stay fixed across turns, reload, resume, and tree navigation.

Everything else is read each turn. When an instruction changes, such as an edited `AGENTS.md` after `/reload`, a changed automatic-check configuration, or a different set of active tools, Pi appends the updated section without rewriting earlier instructions. Models that cannot take later system messages receive the change in the leading instructions, which costs one cache miss on the next request.

Run `/reload` after changing this extension.
