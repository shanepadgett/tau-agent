# Subagent

Subagent delegates one focused task to an isolated child Pi session. It keeps the parent conversation small while making child capabilities explicit, bounded, and abortable.

Agent definitions can override the parent model and thinking level. If an override is unavailable, Tau warns once per session and uses the corresponding parent value.

Tau includes these built-in agents:

- `generalist` handles focused analysis, review, implementation, or mixed work when no narrower agent fits. Delegated tasks should state their scope and desired depth.
- `scout` explores local files and code with `read`, `grep`, `find`, and `ls`.
- `web-research` researches web and code sources with `websearch`, `codesearch`, and `webfetch`.
- `context-sync` maps meaningful uncommitted work into `.pi/contexts`. Agent-driven use is `extensions.context.sync.automation` (requires `sync.enabled`). `/context-sync` is the manual/nudge path when sync is enabled. Validation can auto-run it when validation and sync are enabled.

Ask Tau to delegate a task, or let it call `subagent` with an agent name and task. Children use the parent's current working directory and inherit its model and thinking level unless their definition overrides either value. They do not receive the parent conversation. Tau loads only the extensions that own a child's declared tools, so unrelated extension hooks do not run in child sessions. When a child must inspect another repository, put its exact absolute path in the delegated task.

Fresh calls return a thread ID. Tau can send feedback or follow-up work to that thread, preserving the child's conversation, prior reads, and tool results. It starts a fresh thread for unrelated work or when retained context is stale or oversized. Threads live for the current parent session. Tau retains up to 16 and evicts the least recently used idle thread when needed. Calls to one thread run sequentially.

## Agent definitions

Add Markdown definitions at `~/.pi/agent/tau/agents/*.md` or, in a trusted project, the nearest `.pi/tau/agents/*.md`. Project definitions override user definitions, which override built-ins. Duplicate names in one scope are invalid.

```markdown
---
name: api-reader
description: Inspect API declarations and usage
tools:
  - read
  - grep
model: openai-codex/gpt-5.6-sol
thinking: medium
---

Stay within the delegated task. Return exact paths and symbols.
```

`name`, `description`, and `tools` are required. Optional `model` uses `provider/model`; optional `thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Tool names must be unique, and `subagent` cannot be delegated. Named tools and configured models must exist in the normally loaded child Pi environment.

At most four children run at once. Additional calls wait in order. Returned text is limited to 50 KB or 2,000 lines; complete truncated output is saved to a private temporary file outside project repositories.
