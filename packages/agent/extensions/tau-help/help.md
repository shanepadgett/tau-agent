# Tau

Tau is a coding agent built to be a reliable partner during software work. It cares about quality code, explicit standards, efficient token use, and decisions that hold up after the chat ends. Extensions add focused capabilities; prompts expand into instructions for the next request.

## appshot

Gives the agent macOS window discovery, screenshots, and app activation tools for visual validation. Requires macOS 14 and Screen & System Audio Recording permission.

## aside

Adds `/aside <question>` for a one-off question to the current model without putting the question or answer in the conversation. Choose the current conversation branch or no context. A thinking widget clears when the answer opens. Run `/aside` to reopen the latest answer and `/aside clear` to cancel or clear it.

## attention

Shows attention state when Tau needs the user to look at the chat, finishes a compaction, or summarizes an abandoned branch.

## auto-name

Names sessions from their first request so saved sessions remain findable.

## branch

Adds `/branch` to create and switch Git branches from the TUI. Switching
confirms first, then removes untracked files with `git clean -fd` while keeping
ignored files. Press `Ctrl+F` in the picker to fetch remotes and refresh.

## cache-diagnostics

Records private prompt-cache fingerprints without storing prompt content. Run `/cache-debug` after suspicious cache misses to write a bounded investigation report under `~/.pi/agent/cache-diagnostics/reports/`.

## clear-screen

Adds `/clear-screen` to clear terminal output without changing the session.

## codex-priority

Requests Codex priority processing (Fast mode) for every `gpt-6-luna` request on the `openai-codex` provider, including the agent loop, compaction, tool approval, auto-naming, commit, and handoff. It has no command or setting. Cost uses OpenAI's 2.5x Fast mode rate for GPT-6 models. Do not run another extension that overlays `openai-codex` or sets `service_tier`.

## commit

Adds `/commit` for semantic commit grouping, review, and committing selected repository changes.

## cost-report

Adds `/cost-report` to build an HTML spend report from local session usage. Pick a time frame (past 7 days, current week, current month, year to date, or a specific month) and scope (current project or all sessions). Tau scans sessions, writes under `~/.pi/tau/cost-reports/`, opens the file, and notifies with the path. Empty windows warn without writing a file.

## compaction

Writes compaction summaries (automatic, `/compact`, and overflow recovery) with a cheaper model from the same provider as the session, so Opus, GPT-6.1 Sol, and Astra sessions do not pay their own rates to summarize themselves. Summaries never cross providers, and a notice names the model that wrote each one. When no cheaper model fits, Pi's default compaction runs.

## context

Adds `/context` to browse and inject reusable repository work scopes from `.pi/contexts`. Selecting entries injects them once into the conversation: `read` paths as complete files, `show` targets as current declaration slices, `outline` paths as Explore structures, and one hidden note listing `references` plus instructions to treat the injected material as current. Run `/context` again to inject more. Edit catalog files by hand when work scopes change. Domain folders are `NN_slug` tabs (ordered by the two-digit prefix; UI shows the slug), TOML files are concepts, and TOML sections are selectable entries.

## explore

Structural source tools on in-process tree-sitter (WASM), available on every Node-supported platform. Registers `outline`, `show`, `discover`, `ast_search`, `deps`, `reverse_deps`, `callers`, `callees`, `references`, `implementations`, `impact`, and `context`; `show` takes a top-level `targets` array of path + name objects (+ line when needed). Pi keeps `ls` / `find` / `grep` / `read`. Large full `read`/autoread of registered source (including Markdown) returns outline by default (`explore.read.*`); ranged `read` or `show` for bodies. Disable with `explore.read.enabled: false`.

## footer

Adds `/footer` to toggle and refresh Tau’s status footer.

## handoff

Adds `/handoff <goal>` to start a fresh linked session from the current conversation. Tau generates an opening prompt, autoreads the relevant project files it already knows about, and leaves the prompt in the editor for review instead of submitting it.

## ideas

Adds `/ideas` to log rough ideas or open the ideas browser.

## image-gen

Gives the agent an OpenAI GPT Image and xAI Grok Imagine generation and editing tool. It follows the parent model by default and can override the provider per request. Run `/login openai-codex` or `/login xai` before use. Generated images are saved for inspection.

## manage-sessions

Adds `/manage-sessions` to browse saved sessions and `/sweep` to archive or delete the current session after starting a new one.

## patch

Replaces separate edit/write operations with one multi-file `patch` tool. It can create, rewrite, edit, move, and delete files in one structured call. Fewer tool calls means fewer turns, and each avoided turn prevents the full chat context from being sent again. Tau enables `patch` only for OpenAI and OpenAI Codex models and uses `edit` and `write` for every other provider.

## qna

Adds `/qna` for when the agent has asked you several questions in chat and you want a friendly UI for answering them on your own terms. It is only active when you manually run the command.

## ready

Adds `/ready` to scan agent-readiness rails (cold start, toolchain, verify, lint/entropy, policy, standards, context, and related signals). Choose Markdown or HTML; Tau writes a timestamped report under `.pi/tau/ready/` and notifies with the path. Scan-only in v1 — no model judgment and no scores.

## review

Adds `/review [direction]` for an isolated simplify, architecture, or correctness review. With no direction, it reviews current Git changes. Free-form direction reviews the requested part of the repository even when the working tree is clean. Choose a review type and logged-in provider, then Tau writes the result as Markdown under `.pi/tau/reviews/` without adding it to the parent agent context.

## reference

Adds `/reference` to manage separate repositories kept outside the current project for inspiration or comparison. Add one with `/reference new <git-url>`, update it, switch its referenced branch, or open it in an editor. Select references and explain why they matter; Tau then puts their paths and that reason into the editor for the agent. References stay outside the project so the agent does not wander into unrelated code unless you explicitly point it there.

## run-summary

Shows a compact display-only marker after each run with wall time and model cost. It does not enter agent context.

## runtime-context

Supplies Soul with the local date and root directory snapshot. Both remain fixed across turns, reload, and resume, and refresh after successful compaction.

## script-runner

Gives the agent a first-class `script_runner` tool to execute Python 3, Node.js, and Deno scripts. Dedicated tools come first for ordinary reads, searches, and edits. Scripts are for work those tools cannot reasonably handle, or substantial bulk transformations and computation that would otherwise require many repetitive or error-prone calls; justified scripts use this tool rather than bash. On failure it returns a `scriptId`; the agent retries with targeted `{oldText,newText}` edits against the script it already wrote rather than resending the whole script. Runtimes are detected from the environment (Python 3 via `python3`; `node` is the local Node.js runtime with `--experimental-strip-types`, Node 22.6+ — full Node APIs, TypeScript with erasable syntax or plain JavaScript; `deno` via `deno run -A` — full permissions, native TypeScript/JavaScript, Deno APIs). The tool registers only available runtimes and is hidden from the prompt if none are present.

## silent-command-runner

Runs configured commands while keeping their output out of agent context when that is useful.

## soul

Supplies Tau's communication, discussion, planning, execution, and coding instructions, plus tool-use rules, tool guidance, and context from other Tau extensions. The date and directory snapshot stay fixed until successful compaction. Other changes, such as an edited `AGENTS.md` after `/reload`, arrive as appended updates without rewriting earlier instructions.

Tool-use guidance defaults to dedicated tools for ordinary file work, bash for shell commands, and scripts only when dedicated tools cannot reasonably do the work or when substantial bulk work would otherwise need many repetitive or error-prone calls.

## stash

Adds `Alt+S` to stash the current prompt draft and `/pop` to browse stashed drafts and put one back in the editor.

## tau-help

Adds `/tau-help` to show this guide as rendered Markdown in the chat.

## tau

Adds `/tau`, `/tau init [--global|--project]`, and `/tau doctor` for Tau setup and diagnostics.

## tool-approval

Reviews agent `bash` and `script_runner` requests before they run. Common read-only bash commands skip review. Visible, understood requests need one review; hidden local execution targets get bounded inspection and one final review, without repository exploration. Set `extensions.toolApproval.autoApprove` to run every reviewer-approved request without another confirmation. Those auto-approvals show a user-only marker. The reviewer approves routine, low-impact local and external-service work, including read-only Jira or Confluence requests, additive document creation without consequential side effects, and normal authentication with existing credentials. It asks before meaningful data loss, disruptive system or production changes, privilege or access changes, secret or sensitive-data disclosure, substantial payments, or consequential publication and workflows. Inspection gaps alone do not require confirmation; uninspected executable code, unresolved code loading, and missing information that leaves a substantial risk unresolved do. Approval explanations cover the effect, affected target, risk, and recovery difficulty in plain language. Changes to inspected files invalidate approval. Reviewer failures fall back to human approval and send an attention notification. In the terminal approval panel, press `n` to add a note to Approve or Reject before choosing. Rejection notes tell the agent why the request was blocked; approval notes reach it with the tool result without changing the request. Reject with a note to ask for a revised request.

Approval decisions are saved privately in the session JSONL, including allowlist skips, review stages and models, inspected paths, evidence-gap categories, and user decisions. These records stay out of model context and do not copy scripts, arguments, file contents, or raw errors.

Scoped project edits, builds, tests, and generated-file cleanup should be approved whether they use Python, Node, or bash. Reading, replacing, and writing project text is ordinary editing; computed data paths and a less suitable tool choice do not themselves require confirmation. Destructive changes to valuable databases, remote objects, backups, or unrelated work do. Clearly disposable local test data remains routine validation. Hidden executable code still requires inspection.

## tool-loader

Keeps specialist tool groups out of every request as deferred tools and lets the agent load them with Pi's `tool_search`. Tau registers `web`, `image`, and `appshot`; project or global package extensions can add groups with `registerDeferredToolGroup()` from `@shanepadgett/tau-agent`. All models can load tools. Compatible models preserve the cached prefix; other models can incur a cache miss when tools are activated. Loading never triggers compaction.

## web

Gives the agent compact `websearch`, `webfetch`, and `codesearch` tools for web and implementation research.

## Prompts

Prompt commands expand into instructions before the request reaches the agent.

### cavemanify

`/cavemanify` makes prose short, blunt, and direct.

### implement

`/implement` provides the implementation workflow for an approved change.

### interview

`/interview` drives practical questions when a request is underspecified.

### plan-feature

`/plan-feature` explores a feature and produces a scoped plan before editing.

### plan-implementation

`/plan-implementation` turns an approved plan into concrete implementation steps.

Keep this file updated when an extension or prompt is added, removed, renamed, or its basic usage changes.
