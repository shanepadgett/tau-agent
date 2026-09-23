# Soul

Soul supplies Tau's system prompt: communication, discussion, planning, execution, and coding guidance. It is always on.

Soul captures tools, skills, project instructions, documentation, and environment context in a saved baseline. Reload and resume reuse it. Successful compaction captures a fresh baseline, including a new date and directory listing.

Changes to available agents, automatic checks, approval guidance, and loaded tools are supplied as saved context updates. Earlier instructions and updates keep their positions instead of being rewritten each turn.

Tools that cannot be loaded without changing the cached prefix wait for compaction. Tool execution permissions still take effect immediately. Soul reports incompatible prompt replacements or changes to previously sent history rather than silently replacing its baseline.

Run `/reload` after changing this extension. The first request after installation captures the new Soul baseline; later instruction edits take effect after compaction.
