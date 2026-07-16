# Custom subagents

Tau's `subagent` tool delegates one focused task to an isolated child Pi session. You can add your own agent definitions without writing TypeScript.

Each fresh call returns a thread ID. Continue that thread when feedback or follow-up work depends on the child's prior reads and reasoning:

```text
subagent({ agent: "scout", task: "Trace configuration loading" })
subagent({ thread: "thread-1", task: "Now check whether this proposed fix covers every caller" })
```

Retained threads keep their child conversation and tool results for the current parent session. Start fresh for unrelated work or when earlier context is stale or oversized. Tau keeps up to 16 threads and evicts the least recently used idle thread when needed.

## Where definitions live

| Scope | Path | Use when |
| --- | --- | --- |
| **User (global)** | `~/.pi/agent/tau/agents/*.md` | You want the agent in every project |
| **Project** | nearest trusted `.pi/tau/agents/*.md` | Repo-specific helpers |

Precedence: **project overrides user**, which overrides Tau's built-ins (`scout`, `web-research`). Duplicate names in one scope are invalid.

## Definition format

Markdown with frontmatter:

```markdown
---
name: api-reader
description: Inspect API declarations and usage
tools:
  - read
  - grep
model: openai-codex/gpt-5.4-mini
thinking: medium
---

Stay within the delegated task. Return exact paths and symbols.
```

Required:

- `name`
- `description`
- `tools` (unique tool names; `subagent` cannot be delegated)

Optional:

- `model` as `provider/model`
- `thinking`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`

Named tools and configured models must exist in the normally loaded child Pi environment (including tools from installed packages such as Tau).

## Runtime rules

- Children use the parent's cwd and inherit model/thinking unless the definition overrides them.
- Children do not receive the parent conversation.
- Follow-up calls reuse the retained child's conversation, model, thinking level, tools, and cwd.
- Children load only the extensions that own their declared tools. Unrelated extension hooks do not run in child sessions.
- At most four children run at once; extra calls wait in order.
- Calls to the same retained thread run one at a time.
- Returned text is capped (50 KB / 2,000 lines); full truncated output is saved to a private temp file.

## Built-ins

- `generalist` — focused analysis, review, implementation, or mixed work when no narrower agent fits
- `scout` — local exploration with `read`, `grep`, `find`, `ls`
- `web-research` — `websearch`, `codesearch`, `webfetch`

Ask Tau to delegate, or let it call `subagent` with an agent name and task.
