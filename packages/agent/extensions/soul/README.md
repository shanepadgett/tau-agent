# Soul

Soul supplies Tau's system prompt: communication, discussion, planning, execution, and coding guidance. It is always on.

Soul adds Pi documentation pointers, tool guidance, and the context that other Tau extensions supply, such as the local date, directory snapshot, and automatic-check instructions. The date and directory snapshot are captured on the first prompt and again after successful compaction, so they stay fixed across turns, reload, resume, and tree navigation.

Everything else is read each turn. When an instruction changes, such as an edited `AGENTS.md` after `/reload`, a changed automatic-check configuration, or a different set of active tools, Pi appends the updated section without rewriting earlier instructions. Models that cannot take later system messages receive the change in the leading instructions, which costs one cache miss on the next request.

Run `/reload` after changing this extension.
