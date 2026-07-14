# Tau

Tau is a coding agent built to be a reliable partner during software work. It cares about quality code, explicit standards, efficient token use, and decisions that hold up after the chat ends. Extensions add focused capabilities; prompts expand into instructions for the next request.

## appshot

Gives the agent macOS window discovery, screenshots, and app activation tools for visual validation. Requires macOS 14 and Screen & System Audio Recording permission.

## attention

Shows attention state when Tau needs the user to look at the chat.

## auto-name

Names sessions from their first request so saved sessions remain findable.

## branch

Adds `/branch` to create and switch Git branches from the TUI.

## clear-screen

Adds `/clear-screen` to clear terminal output without changing the session.

## commit

Adds `/commit` for semantic commit grouping, review, and committing selected repository changes.

## context

Adds `/context` to select reusable repository work scopes from `.pi/contexts`, and `/context-sync` to reconcile affected scopes from current Git changes. Tau automatically validates changed-file membership and stale references after agent turns. Folder names are tabs, TOML files are concepts, and TOML sections are selectable entries.

## explore

Replaces Pi’s filesystem inspection tools with compact Tau versions: `ls`, `find`, `grep`, and `read`. They produce smaller model payloads and readable tool rows. Repeated `read` calls return unchanged markers or useful diffs when branch history proves the agent already saw the base content. A failed patch unlocks one normal reread of the affected path. `/read-stats` shows estimated token and cost savings for the current chat and whole session.

## footer

Adds `/footer` to toggle and refresh Tau’s status footer.

## ideas

Adds `/ideas` to log rough ideas or open the ideas browser.

## image-gen

Gives the agent an image-generation tool using the configured image service. Generated images are saved for inspection.

## xai

Adds Grok 4.5 and Grok Imagine through an xAI Grok subscription OAuth login. Run `/login` and select xAI before use.

## manage-sessions

Adds `/manage-sessions` to browse saved sessions and `/sweep` to archive or delete the current session after starting a new one.

## patch

Replaces separate edit/write operations with one multi-file `patch` tool. It can create, rewrite, edit, move, and delete files in one structured call. Fewer tool calls means fewer turns, and each avoided turn prevents the full chat context from being sent again.

## publish

Adds `/publish` to create a tagged release, trigger trusted npm publishing in GitHub Actions, and show its status. It recommends a semantic version bump from commits since the prior release tag, but you must confirm the release type and publish action.

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

Gives Tau a subagent delegation tool for isolated, focused work. You can also create your own subagents in the supported subagent directories. Ask Tau how to do it and have it consult the extension’s own documentation; the built-in `scout` and `web-research` subagents show the pattern. Each subagent can register its own model and the tools it is allowed to use.

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
