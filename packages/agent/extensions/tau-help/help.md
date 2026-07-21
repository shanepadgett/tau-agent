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

## clear-screen

Adds `/clear-screen` to clear terminal output without changing the session.

## commit

Adds `/commit` for semantic commit grouping, review, and committing selected repository changes.

## context

Adds `/context` to select reusable repository work scopes from `.pi/contexts`, and `/context-sync` or `/context-sync <nudge>` for human-driven catalog sync (optional nudge). Escape cancels a running manual sync. When `sync.automation` is on, the coding agent can also run the `context-sync` subagent after meaningful uncommitted work. `sync.enabled` is the master switch for command, automation, and validation auto-run. Entry `files` are autoread; entry `anchors` are unloaded navigation paths. Context validation is off by default; when on (and sync enabled), Tau auto-runs context-sync on failure. Folder names are tabs, TOML files are concepts, and TOML sections are selectable entries.

## context-pruning

Gives the agent `context_prune` for removing substantial stale tool evidence after broad exploration converges. The agent records durable conclusions before creating an anchor, can retain exact exchanges or current file knowledge, and continues the task automatically. Context markers occasionally steer the agent after tool-heavy growth and become more direct under pressure. Run `/prune` with no arguments to request an anchor manually. Session history remains unchanged, and anchors, markers, and pruned-row state follow the active branch.

## explore

Replaces Pi’s filesystem inspection tools with compact Tau versions: `ls`, `find`, `grep`, and `read`. They produce smaller model payloads and readable tool rows. Repeated `read` calls return unchanged markers or useful diffs when branch history proves the agent already saw the base content. A failed patch unlocks one normal reread of the affected path. `/read-stats` shows estimated token and cost savings for the current chat and whole session.

## footer

Adds `/footer` to toggle and refresh Tau’s status footer.

## ideas

Adds `/ideas` to log rough ideas or open the ideas browser.

## image-gen

Gives the agent a Grok Imagine generation and editing tool. Run `/login xai` and choose a subscription or API-key login before use. Generated images are saved for inspection.

## manage-sessions

Adds `/manage-sessions` to browse saved sessions and `/sweep` to archive or delete the current session after starting a new one.

## patch

Replaces separate edit/write operations with one multi-file `patch` tool. It can create, rewrite, edit, move, and delete files in one structured call. Fewer tool calls means fewer turns, and each avoided turn prevents the full chat context from being sent again. Tau keeps `patch` disabled and uses `edit` and `write` for xAI and Grok models.

## publish

Adds `/publish` to create a tagged release, trigger trusted npm publishing in GitHub Actions, and show its status. It recommends a semantic version bump from commits since the prior release tag, but you must confirm the release type and publish action. If publishing fails, the agent investigates with read-only diagnostics and recommends a solution without applying it or retrying the release.

## qna

Adds `/qna` for when the agent has asked you several questions in chat and you want a friendly UI for answering them on your own terms. It is only active when you manually run the command.

## reference

Adds `/reference` to manage separate repositories kept outside the current project for inspiration or comparison. Add one with `/reference new <git-url>`, update it, switch its referenced branch, or open it in an editor. Select references and explain why they matter; Tau then puts their paths and that reason into the editor for the agent. References stay outside the project so the agent does not wander into unrelated code unless you explicitly point it there.

## run-summary

Shows a compact display-only marker after each run with wall time and model cost. It does not enter agent context.

## runtime-context

Supplies the agent with the current local date and an initial root directory snapshot as hidden session context.

## silent-command-runner

Runs configured commands while keeping their output out of agent context when that is useful.

## soul

Adds Rok’s persona and operating rules to Pi’s native assistant prompt.

## stash

Adds `Alt+S` to stash the current prompt draft and `/pop` to browse stashed drafts and put one back in the editor.

## subagent

Gives Tau a subagent delegation tool for isolated, focused work. Known files can be autoread as line-numbered snapshots into a fresh or retained child turn. Tau can continue a retained child thread when follow-up work depends on its prior reads and reasoning. You can also create your own subagents in the supported subagent directories. Ask Tau how to do it and have it consult the extension’s own documentation; the built-in agents show the pattern. Each subagent can register its own model, tools, and pool of display names. Reused pool names get numeric suffixes. In interactive cmux sessions, Tau opens one temporary Markdown dashboard for live subagent progress; it does not change how children run and closes shortly after the active cohort finishes.

## tau-help

Adds `/tau-help` to show this guide as rendered Markdown in the chat.

## tau

Adds `/tau`, `/tau init [--global|--project]`, and `/tau doctor` for Tau setup and diagnostics.

## tool-loader

Progressively exposes specialist tools through `load_tools`. Tau normally loads the fixed `web`, `image`, and `appshot` groups itself when needed; supported providers can preserve more prompt-cache reuse.

## turn-budget

Tracks and limits agent turns to keep work bounded.

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
