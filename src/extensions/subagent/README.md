# Subagent

Subagent delegates one focused task to an isolated child Pi session. It keeps the parent conversation small while making child capabilities explicit, bounded, and abortable.

Tau includes two read-only agents:

- `scout` explores local files and code with `read`, `grep`, `find`, and `ls`.
- `web-research` researches web and code sources with `websearch`, `codesearch`, and `webfetch`.

Ask Tau to delegate a task, or let it call `subagent` with an agent name and task. Children use the parent's current working directory, exact model, and thinking level. They do not receive the parent conversation. When a child must inspect another repository, put its exact absolute path in the delegated task.

## Agent definitions

Add Markdown definitions at `~/.pi/agent/tau/agents/*.md` or, in a trusted project, the nearest `.pi/tau/agents/*.md`. Project definitions override user definitions, which override built-ins. Duplicate names in one scope are invalid.

```markdown
---
name: api-reader
description: Inspect API declarations and usage
tools:
  - read
  - grep
---

Stay within the delegated task. Return exact paths and symbols.
```

Only `name`, `description`, and `tools` are supported. All are required, tool names must be unique, and `subagent` cannot be delegated. A named tool must exist in the normally loaded child Pi environment.

At most four children run at once. Additional calls wait in order. Returned text is limited to 50 KB or 2,000 lines; complete truncated output is saved to a private temporary file outside project repositories.
