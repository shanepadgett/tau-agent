# Tau

Tau is a coding agent built to be a reliable partner during software work. It cares about quality code, explicit standards, efficient token use, and decisions that hold up after the chat ends. Extensions add focused capabilities; prompts expand into instructions for the next request.

## appshot

Gives the agent macOS window discovery, screenshots, and app activation tools for visual validation. Requires macOS 14 and Screen & System Audio Recording permission.

## aside

Adds `/aside <question>` for a one-off question to the current model without putting the question or answer in the conversation. Choose the current conversation branch or no context. A thinking widget clears when the answer opens. Run `/aside` to reopen the latest answer and `/aside clear` to cancel or clear it.

## attention

Shows attention state when Tau needs the user to look at the chat, finishes a manual compaction, or summarizes an abandoned branch. Automatic compaction stays quiet until its resumed work settles.

## auto-name

Names sessions from their first request so saved sessions remain findable.

## auto-compact

Uses Pi's native compaction before a model turn when the current context reaches `extensions.autoCompact.tokenLimit`, which defaults to 175,000 tokens for every model. Interrupted work resumes through a hidden continuation message without an attention alert until the resumed work settles. Pi's native collapsed compaction entry remains visible in chat.

## branch

Adds `/branch` to create and switch Git branches from the TUI.

## cache-diagnostics

Records private prompt-cache fingerprints without storing prompt content. Run `/cache-debug` after suspicious cache misses to write a bounded investigation report under `~/.pi/agent/cache-diagnostics/reports/`.

## clear-screen

Adds `/clear-screen` to clear terminal output without changing the session.

## commit

Adds `/commit` for semantic commit grouping, review, and committing selected repository changes.

## context

Adds `/context` to inject reusable repository work scopes from `.pi/contexts`, and `/context-sync` or `/context-sync <nudge>` for human-driven catalog sync. Selecting entries injects them once into the conversation: `read` paths as complete files, `show` targets as current declaration slices, `outline` paths as Explore structures, and one hidden note listing `references` plus instructions to treat the injected material as current. Run `/context` again to inject more. Manual sync replaces the editor with a status panel; Escape or Ctrl+C cancels. When `sync.automation` is on, coding agent can also run `context-sync` after meaningful uncommitted work. Sync catalogs durable code and long-lived documentation; recurring scratch, planning, interview, and rough-idea paths belong in `validation.ignoreGlobs`. `sync.enabled` is master switch for command, automation, and validation auto-run. Context validation is off by default; when on (and sync enabled), Tau auto-runs context-sync on failure. Domain folders are `NN_slug` tabs (ordered by the two-digit prefix; UI shows the slug), TOML files are concepts, and TOML sections are selectable entries.

## effort

Adds `/effort [quick|standard|deep]` to select effort and a provider from current logins. Tau selects provider’s best available model for tier, then tries its configured model fallback. `Ctrl+Shift+E` cycles tiers on current provider. Footer derives effort from current provider, model, and thinking level, and hides it when no configured tier matches.

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

Replaces separate edit/write operations with one multi-file `patch` tool. It can create, rewrite, edit, move, and delete files in one structured call. Fewer tool calls means fewer turns, and each avoided turn prevents the full chat context from being sent again. Tau keeps `patch` disabled and uses `edit` and `write` for xAI and Grok models.

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

Supplies the agent with the current local date and an initial root directory snapshot as hidden session context.

## script-runner

Gives the agent a first-class `script_runner` tool to execute Python 3, Node.js, and Deno scripts instead of bash. On failure it returns a `scriptId`; the agent retries with targeted `{oldText,newText}` edits against the script it already wrote rather than resending the whole script. Runtimes are detected from the environment (Python 3 via `python3`; `node` is the local Node.js runtime with `--experimental-strip-types`, Node 22.6+ — full Node APIs, TypeScript with erasable syntax or plain JavaScript; `deno` via `deno run -A` — full permissions, native TypeScript/JavaScript, Deno APIs). The tool registers only available runtimes and is hidden from the prompt if none are present.

## silent-command-runner

Runs configured commands while keeping their output out of agent context when that is useful.

## soul

Adds the baseline Tau system prompt on every session: communication style, operating model, and code style.

## stash

Adds `Alt+S` to stash the current prompt draft and `/pop` to browse stashed drafts and put one back in the editor.

## subagent

Gives Tau a subagent delegation tool for isolated, focused work. Run `/agents` to enable or disable individual agents for the current session, or set `extensions.subagent.disabled` in Tau settings for a persistent choice. `scout` is substantial multi-hop local code lookup that would chew parent context; facts only, not small digs; `web-research` handles external research. Known files can be autoread as line-numbered snapshots into a fresh or retained child turn. Tau can continue a retained child thread when follow-up work depends on its prior reads and reasoning. You can also create your own subagents in supported subagent directories. Ask Tau how to do it and have it consult extension documentation; built-in agents show pattern. Each subagent can register its own model, tools, and pool of display names. Reused pool names get numeric suffixes. In interactive cmux sessions, Tau opens one temporary Markdown dashboard for live subagent progress; it does not change how children run and closes shortly after active cohort finishes.

## tau-help

Adds `/tau-help` to show this guide as rendered Markdown in the chat.

## tau

Adds `/tau`, `/tau init [--global|--project]`, and `/tau doctor` for Tau setup and diagnostics.

## tool-approval

Reviews agent `bash` and `script_runner` requests before they run. Common read-only bash commands skip review. Set `extensions.toolApproval.autoApprove` to run every reviewer-approved request without another confirmation. Those auto-approvals show a user-only marker. The reviewer approves routine local development work. Concrete destructive, system, production, privileged, or security-sensitive effects require human approval with one explanatory paragraph. Reviewer failures fall back to human approval and send an attention notification.

## tool-loader

Progressively exposes registered specialist tool groups through `load_tools`. Tau registers `web`, `image`, and `appshot`; project or global package extensions can add groups with `registerDeferredToolGroup()` from `@shanepadgett/tau-agent`. Supported providers can preserve more prompt-cache reuse.

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
