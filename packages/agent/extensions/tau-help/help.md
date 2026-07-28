# Tau

Tau is a coding agent built to be a reliable partner during software work. It cares about quality code, explicit standards, efficient token use, and decisions that hold up after the chat ends. Extensions add focused capabilities; prompts expand into instructions for the next request.

## appshot

Gives the agent macOS window discovery, screenshots, and app activation tools for visual validation. Requires macOS 14 and Screen & System Audio Recording permission.

## attention

Shows attention state when Tau needs the user to look at the chat, finishes compacting a session, or summarizes an abandoned branch.

## auto-name

Names sessions from their first request so saved sessions remain findable.

## branch

Adds `/branch` to create and switch Git branches from the TUI.

## cache-diagnostics

Records private prompt-cache fingerprints without storing prompt content. Run `/cache-debug` after suspicious cache misses to write a bounded investigation report under `~/.pi/agent/cache-diagnostics/reports/`.

## clear-screen

Adds `/clear-screen` to clear terminal output without changing the session.

## commit

Adds `/commit` for semantic commit grouping, review, and committing selected repository changes.

## context

Adds `/context` to set branch-local reusable repository work scopes from `.pi/contexts`, and `/context-sync` or `/context-sync <nudge>` for human-driven catalog sync. Active entries produce one ephemeral per-call projection instead of transcript messages. Entry `read` paths supply exact contents, `outline` paths use Explore, and `references` stay unloaded. Clear all selections and confirm to remove active context. Escape cancels a running manual sync. When `sync.automation` is on, coding agent can also run `context-sync` after meaningful uncommitted work. Sync catalogs durable code and long-lived documentation; recurring scratch, planning, interview, and rough-idea paths belong in `validation.ignoreGlobs`. `sync.enabled` is master switch for command, automation, and validation auto-run. Context validation is off by default; when on (and sync enabled), Tau auto-runs context-sync on failure. Folder names are tabs, TOML files are concepts, and TOML sections are selectable entries.

## working-memory

Gives agent `working_memory` for selective hard checkpoints. Model-only references identify useful conversation evidence and complete tool exchanges. Requested source files return as structural outlines, while deferred files remain cheap conditional reminders. Everything else before checkpoint leaves future model input without changing saved session. Advisory reminders begin at 40k active-context tokens. Run `/prune` to request reassessment manually.

## explore

Structural source tools on in-process tree-sitter (WASM), available on every Node-supported platform. Registers `outline`, `show`, `discover`, `ast_search`, `deps`, `reverse_deps`, `callers`, `callees`, `references`, `implementations`, `impact`, and `context`; symbol targets use path + name (+ line when needed). Pi keeps `ls` / `find` / `grep` / `read`. Large full `read`/autoread of registered source (including Markdown) returns outline by default (`explore.read.*`); ranged `read` or `show` for bodies. Disable with `explore.read.enabled: false`.

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

## publish

Adds `/publish` to create a tagged release, trigger trusted npm publishing in GitHub Actions, and show its status. It recommends a semantic version bump from commits since the prior release tag, but you must confirm the release type and publish action. If publishing fails, the agent investigates with read-only diagnostics and recommends a solution without applying it or retrying the release.

## qna

Adds `/qna` for when the agent has asked you several questions in chat and you want a friendly UI for answering them on your own terms. It is only active when you manually run the command.

## review

Adds `/review` for explicit isolated review of current Git changes. Choose `simplify`, `architecture`, or `correctness`, or run a mode directly. Results stay outside agent context until you send them from result view, and can be exported under `.pi/tau/reviews/`. `/review show` reopens latest result on current session branch.

## reference

Adds `/reference` to manage separate repositories kept outside the current project for inspiration or comparison. Add one with `/reference new <git-url>`, update it, switch its referenced branch, or open it in an editor. Select references and explain why they matter; Tau then puts their paths and that reason into the editor for the agent. References stay outside the project so the agent does not wander into unrelated code unless you explicitly point it there.

## run-summary

Shows a compact display-only marker after each run with wall time and model cost. It does not enter agent context.

## runtime-context

Supplies the agent with the current local date and an initial root directory snapshot as hidden session context.

## script-runner

Gives the agent a first-class `script_runner` tool to execute Python and TypeScript instead of bash. On failure it returns a `scriptId`; the agent retries with targeted `{oldText,newText}` edits against the script it already wrote rather than resending the whole script. Languages are detected from the environment (Python via `python3`/`python`; TypeScript via Node `--experimental-strip-types`, Node 22.6+). The tool registers only available languages and is hidden from the prompt if neither is present.

## silent-command-runner

Runs configured commands while keeping their output out of agent context when that is useful.

## soul

Adds two independently toggleable sections to Pi’s native assistant prompt: `ponytail` (a lazy-senior-dev build ethos) and `caveman` (a terse communication style). Both on by default.

## stash

Adds `Alt+S` to stash the current prompt draft and `/pop` to browse stashed drafts and put one back in the editor.

## subagent

Gives Tau a subagent delegation tool for isolated, focused work. Run `/agents` to enable or disable individual agents for the current session, or set `extensions.subagent.disabled` in Tau settings for a persistent choice. `scout` is substantial multi-hop local code lookup that would chew parent context; facts only, not small digs; `web-research` handles external research. Known files can be autoread as line-numbered snapshots into a fresh or retained child turn. Tau can continue a retained child thread when follow-up work depends on its prior reads and reasoning. You can also create your own subagents in supported subagent directories. Ask Tau how to do it and have it consult extension documentation; built-in agents show pattern. Each subagent can register its own model, tools, and pool of display names. Reused pool names get numeric suffixes. In interactive cmux sessions, Tau opens one temporary Markdown dashboard for live subagent progress; it does not change how children run and closes shortly after active cohort finishes.

## tau-help

Adds `/tau-help` to show this guide as rendered Markdown in the chat.

## tau

Adds `/tau`, `/tau init [--global|--project]`, and `/tau doctor` for Tau setup and diagnostics.

## tool-loader

Progressively exposes specialist tools through `load_tools`. Tau normally loads the fixed `web`, `image`, and `appshot` groups itself when needed; supported providers can preserve more prompt-cache reuse.

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
