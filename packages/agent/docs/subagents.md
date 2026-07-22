# Custom subagents

Tau's `subagent` tool delegates one focused task to an isolated child Pi session. You can add your own agent definitions without writing TypeScript.

Each fresh call returns a thread ID. Continue that thread when feedback or follow-up work depends on the child's prior reads and reasoning:

```text
subagent({ agent: "review", task: "Review configuration loading" })
subagent({ thread: "thread-1", task: "Now check whether this proposed fix covers every caller" })
```

Retained threads keep their complete child conversation for five minutes after the latest child response. A later follow-up keeps the same thread, agent, model, thinking level, tools, and cwd, but starts a clean child session. Tau supplies prior tasks, exact terminal results, and paths passed through `files`; it does not run a summarization request. Old source, tool history, intermediate responses, and thinking are absent, so the child reads current source before relying on a retained path. Start fresh for unrelated work. Tau keeps up to 16 threads and evicts the least recently used idle thread when needed.

If the relevant files are already known, autoread them into a fresh or retained child turn:

```text
subagent({ agent: "review", task: "Review the runtime change", files: ["src/runtime.ts", "test/runtime.test.ts"] })
```

Paths may be relative to the parent's current working directory or absolute. Tau reads current, line-numbered snapshots when the turn starts. Unreadable files produce failed context entries without stopping the child. Keep the list focused because complete snapshots consume the child's context window.

## Where definitions live

| Scope | Path | Use when |
| --- | --- | --- |
| **User (global)** | `~/.pi/agent/tau/agents/*.md` | You want the agent in every project |
| **Project** | nearest trusted `.pi/tau/agents/*.md` | Repo-specific helpers |

Precedence: **project overrides user**, which overrides Tau's built-ins (`review`, `web-research`). Duplicate names in one scope are invalid.

## Definition format

Markdown with frontmatter:

```markdown
---
name: api-reader
description: Inspect API declarations and usage
tools:
  - read
  - grep
names:
  - Ledger
  - Quill
  - Beacon
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

- `names`: a non-empty list of unique display names
- `model` as `provider/model`
- `thinking`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`

Named tools and configured models must exist in the normally loaded child Pi environment (including tools from installed packages such as Tau).

Tau assigns one display name to each fresh child and keeps it for follow-up turns on that thread. It cycles through the list in order. When the list wraps, reused names get numeric suffixes such as `Ledger-2`, so any number of concurrent children can still have distinct names. Without `names`, the agent name is used as a one-item pool.

## Runtime rules

- Children use the parent's cwd and inherit model/thinking unless the definition overrides them.
- Children do not receive the parent conversation.
- Calls can include `files` to autoread line-numbered snapshots into that child turn.
- Follow-up calls within five minutes reuse the complete child conversation. Colder calls resume from exact prior results and relevant paths in a clean session.
- Cold resume keeps the selected model, thinking level, tools, cwd, definition, display name, and thread ID.
- Children load only the extensions that own their declared tools. Unrelated extension hooks do not run in child sessions.
- At most four children run at once; extra calls wait in order.
- Calls to the same retained thread run one at a time.
- Display names identify children in Tau's tool rows and cmux dashboard; thread IDs remain the identifiers used for continuation calls.
- Returned text is capped (50 KB / 2,000 lines); full truncated output is saved to a private temp file.
- Interactive cmux sessions get one temporary Markdown dashboard for waiting and running invocations. It is observational only: cmux latency or failure cannot delay, fail, or reorder children. The dashboard closes shortly after the active cohort finishes. Print mode never opens it.

## Built-ins

- `review` — adversarial, read-only review for correctness, runtime risks, duplication, and over- or under-engineering
- `web-research` — `websearch`, `codesearch`, `webfetch`
- `context-sync` — maps meaningful uncommitted work into `.pi/contexts`. Offered to the coding agent when `extensions.context.sync.enabled` and `sync.automation` are true. Manual `/context-sync` remains when sync is enabled with `automation` false. Validation can auto-run it when `validation.enabled` and `sync.enabled`

Ask Tau to delegate, or let it call `subagent` with an agent name and task.
