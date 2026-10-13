# Features

## Models

- **Providers:** three wire protocols and three subscription logins. The two ChatGPT plan logins are equal choices: Sign in with ChatGPT registers Tau as its own app, and the Codex login connects as the Codex CLI does and also works with a device code.

  | Provider | Protocol | Login |
  | --- | --- | --- |
  | Anthropic | Anthropic Messages | Claude subscription OAuth |
  | OpenAI | OpenAI Responses | API key |
  | ChatGPT (`chatgpt`) | OpenAI Responses, public API | ChatGPT plan: Sign in with ChatGPT |
  | Codex (`codex`) | OpenAI Responses, Codex backend | ChatGPT plan: Codex login |
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
- **`run` (experiment):** runs JavaScript through `@opencode/codemode`, an interpreter for the subset of JavaScript scripts need. Every other capability (shell, file reads, search, web, process sessions, Python and Node scripts, extension functions) is a function inside it. Scripts chain calls and filter results, so only what they print reaches context. The script decides what runs in sequence (`await` each call) and what runs in parallel (`Promise.all`). Writes to the same file are queued so parallel calls cannot lose edits.
- **Script edits:** a failed `run` returns a script id. The model retries by sending edits to that script instead of the whole script, as Tau's `eval` tool does today.
- **Deferred functions:** extension functions stay out of the `run` description until the model finds them with the interpreter's built-in `search`. A found function is added as a new entry, not edited into the description, and folds into the description at the next compaction.
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
- **Prompt classifier:** one decision-model call per submitted prompt, run after the prompt shows. It handles routing, and flags requests that seem off-topic for the chat so the UI can offer a handoff.
- **Function and skill suggestions:** the classifier also weighs the prompt and other signals (recent files, the work in progress, functions used lately) and picks the deferred functions and skills likely to be needed. Only their names go to the model, in a short note added with the prompt, as things it may look up. The full catalog stays hidden, and no instructions tell the model which groups to search. The note is appended with the user's message, so the cached prefix is untouched.

## Conversation

- **Steering:** a message sent while the agent works is delivered at the next step boundary.
- **Follow-ups:** a message queued while the agent works waits until the run ends, then starts the next run.
- **Custom messages:** the user or an extension can add a message to the chat, and choose whether it starts a turn.
- **Branching:** conversations form a tree, as in Pi, but cleaner and easier to understand. Designed at build step 3.

- **Question tracker (to consider):** Tau tracks the questions it asks the user during planning and interviews, keeps the open ones in one place, and clears each when it is answered. Design not started.

## Prompts and skills

- **One Markdown format** for prompt files and skills, following the Agent Skills standard for skills.
- **Arguments, a blend of OpenCode and Pi:** `$ARGUMENTS` or `$@` for everything typed, `$1`, `$2` for positional arguments with shell-like quoting, `${1:-default}`, `${@:N}` and `${@:N:L}` for defaults and ranges, and an optional `argument-hint`. The highest-numbered placeholder takes the rest of the line, and a template with no placeholder gets the arguments appended (both from OpenCode).
- **Code blocks run when the file is used:** `` !`git status --short` `` inserts a shell command's output, and a fenced `ts run` block runs TypeScript on Tau's Bun and inserts its return value. Arguments reach shell blocks as environment variables, not pasted into the command text, so typed input cannot inject commands (OpenCode pastes them). If a block fails, Tau shows the error and does not send. Each block's command and output show collapsed in the chat.
- **Skills run their blocks** when the model chooses the skill or the user invokes it.
- **Skills are always deferred:** none are listed in the system prompt. The model finds them by search, like deferred functions, and the classifier suggests likely ones.
- **User-only skills:** `disable-model-invocation: true` hides a skill from the model, so only the user can invoke it, as in Pi and OpenCode.

## Interface

- **TUI:** a chat pane and a sidebar, built on OpenTUI. The sidebar shows session state (context use, cost, running processes, compaction in progress) instead of Pi-style footers. Extensions add UI through named slots.
- **Base system prompt:** Soul is Tau's default, and an extension can replace it until the session's first model call ([sdk-catalog.md](sdk-catalog.md#replaceable-runtime-parts)). The runtime context (date, directory snapshot) and other guidance are instruction sources; their changes arrive as notes in the chat.

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
