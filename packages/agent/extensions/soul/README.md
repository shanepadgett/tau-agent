# Soul

Soul supplies Tau's system prompt: communication, discussion, planning, execution, coding, and tool-use guidance. It is always on.

The agent uses dedicated tools first for ordinary reads, searches, and edits. For shell-side inspection, it uses concise read-only commands and pipelines, with tools such as `rg`, `find`, and `jq` to filter output at the source. Custom Python, Node, or Deno code runs through `script_runner`, not through bash snippets, heredocs, or temporary source files. Bash remains useful for direct shell commands, existing project commands, and tasks that genuinely need shell-specific behavior. Naturally fitting, known-safe read-only bash commands may bypass a reviewer call; the agent does not reshape custom code to reach that fast path.

Soul adds Pi documentation pointers, tool guidance, and the context that other Tau extensions supply, such as the local date, directory snapshot, and automatic-check instructions. The date and directory snapshot are captured on the first prompt and again after successful compaction, so they stay fixed across turns, reload, resume, and tree navigation.

Soul also reads `~/.agents/AGENTS.md` as user-level instructions in a separate `user-instructions` section. It loads the file when the extension initializes and keeps that content fixed until `/reload`. Missing or empty files add no instructions. These instructions supplement Pi's global and project context files.

Everything else is read each turn. When an instruction changes, such as an edited `AGENTS.md` after `/reload`, a changed automatic-check configuration, or a different set of active tools, Pi appends the updated section without rewriting earlier instructions. Models that cannot take later system messages receive the change in the leading instructions, which costs one cache miss on the next request.

Run `/reload` after changing this extension.
