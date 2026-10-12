# Features

## Models

- **Providers:** three wire protocols and two subscription logins.

  | Provider | Protocol | Login |
  | --- | --- | --- |
  | Anthropic | Anthropic Messages | Claude subscription OAuth |
  | OpenAI | OpenAI Responses | API key |
  | OpenAI Codex | OpenAI Responses | ChatGPT subscription OAuth |
  | OpenRouter | OpenAI Chat Completions | API key |
  | OpenCode Go | OpenAI Chat Completions | API key |

- **Structured output:** a single completion call (no agent loop) can take a JSON schema and return a parsed, validated object. Each protocol uses its native feature: Anthropic structured outputs, Responses `text.format` with `json_schema`, Chat Completions `response_format` with `json_schema`. Where a model lacks it, fall back to a forced tool call. Invalid output is retried once, then fails. Pi only applies JSON schemas to tool parameters, not to responses.
- **Decision models:** classification is a core capability next to chat, with structured questions and answers. Jev (via OpenRouter) and Luna (via OpenAI or OpenRouter) must work. Decisions use each provider's decision API, not structured output.
- **Claude Code compatibility:** Anthropic subscription OAuth sends what Pi sends to look like Claude Code (system prompt identity, tool-name casing).
- **Codex priority:** Luna always uses the fast priority tier.

## Modes

- Interactive and print. No RPC.
- The submitted prompt appears in the chat immediately; slow work such as routing runs after and reports progress.

## Tools

- **Two tools:** `run` and `checks`. Nothing else is model-visible.
- **`run` (experiment):** runs JavaScript in a QuickJS sandbox. Every other capability (shell, file reads, search, web, process sessions, Python and Node scripts, extension functions) is a function inside it. Scripts chain calls and filter results, so only what they print reaches context. The script decides what runs in sequence (`await` each call) and what runs in parallel (`Promise.all`). Writes to the same file are queued so parallel calls cannot lose edits.
- **Script edits:** a failed `run` returns a script id. The model retries by sending edits to that script instead of the whole script, as Tau's `eval` tool does today.
- **Deferred functions:** extension functions stay out of the `run` description until the model finds them with `searchTools` and `describeTool`, as in Pi codemode.
- **No write or edit tools:** the model changes files however is most efficient: a script, a regex across many files, `sh`, a codemod. Small helpers (`read`, `write`, `replace(path, old, new)`) exist as sandbox functions the model may skip.
- **Checks:** replaces Silent Command Runner, keeping its settings shape (`command`, `{files}`, globs, `cwd`, `env`, timeout, output limits) and silent behavior. Each entry has a mode:

  | Mode | Runs | Agent sees |
  | --- | --- | --- |
  | `fix` | once after each `run` call that changed matching files | nothing |
  | `check` | when the agent calls `checks` after all work is done; at the end of the run if it skipped them or edited after | failures |
  | `final` | always at the end of the run | failures |

  Edits after a passing `checks` call make the result stale. A fallback failure continues the run so the agent can fix it.
- **Process sessions:** borrowed from Codex's unified exec, our own implementation. The agent starts commands in a PTY or with plain pipes, leaves them running, writes to their stdin, and lists, reads, and kills them. A command that finishes within its wait returns output and exit code; otherwise it returns a session id and the output so far. Output is kept in a capped head-and-tail buffer. Starting limits from Codex: wait 250 ms to 30 s, at most 64 sessions, 1 MiB buffer.
- **Dropped:** the ast-grep and tree-sitter tools (`outline`, `show`, `discover`, `ast_search`, dependency and relationship tools, `impact`, `context`). They cost a lot of context for little value.

## Context

- **Background compaction:** borrowed from Pi durable. Above `window − reserve − background` (defaults 16k and 32k), a summary starts in the background while the chat continues. Above `window − reserve`, the next request waits for it. The summary covers everything before a cut that keeps about 20k recent tokens, never splitting a tool call from its result. It is placed when idle or at the next turn boundary, so work done meanwhile stays verbatim. A summary overtaken by a later cut is dropped. A "context too long" error compacts and retries once.
- **Reset:** start a fresh context from a handoff note. Old entries stay in storage.
- **Prompt classifier:** one decision-model call per submitted prompt, run after the prompt shows. It handles routing, suggests deferred function groups that look relevant, and flags requests that seem off-topic for the chat so the UI can offer a handoff.

## Interface

- **TUI:** a chat pane and a sidebar, built on OpenTUI. The sidebar shows session state (context use, cost, running processes, compaction in progress) instead of Pi-style footers. Extensions add UI through named slots.
- **Base system prompt:** Soul and the runtime context (date, directory snapshot) are Tau's own system prompt, not an extension.

## Extensions

- No Pi compatibility. One SDK, imported as `@shanepadgett/tau`.
- Built-ins are redesigned as first-party services on the same mechanism third-party extensions use, not ported as-is.

## Built-ins from `main`

| Built-in | Notes |
| --- | --- |
| md-lint | A default `fix` check. |
| attention | Notifications when Tau needs the user. |
| commit | |
| auto-name | Names chat sessions in the background. |
| branch | Switch to or create typed git branches. |
| cost-report | |
| stash | |
| tool-approval | |
| web | Search and fetch, as `run` functions. |
| image-gen | As `run` functions. |
| worktree | |
| run-summary | |
| qna | Keep how it is invoked. |
| handoff | Plus the classifier's off-topic prompt. |
| reference | Must be faster and less laggy than today. |
| aside | Opens in a side panel. |
| manage-sessions | A mix of Tau's and Pi's session management, or something new. Designed when we get there. |

Dropped for now: explore, patch, footer (replaced by the sidebar), tool-loader (replaced by deferred functions), ready, review, ideas, cache-diagnostics, clear-screen, tau, tau-help, appshot. Decisions, routing, compaction, Soul, and runtime-context move into core.
