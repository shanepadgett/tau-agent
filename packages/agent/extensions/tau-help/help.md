# Tau

Tau is a coding agent. Use slash commands for the features below; the agent uses tools as needed while working.

## appshot

Lets the agent find, capture, and activate macOS windows to check an interface. Requires macOS 14 and Screen & System Audio Recording permission.

## aside

Use `/aside <question>` to ask the current model without adding the exchange to your conversation. Choose whether to include conversation context. `/aside` reopens the latest answer; `/aside clear` cancels or clears it.

## attention

Signals when Tau needs your attention, finishes compaction, or summarizes an abandoned branch.

## auto-name

Names sessions from their first request so you can find them later.

## branch

Use `/branch` to create or switch Git branches. Switching asks for confirmation and deletes untracked files with `git clean -fd`, but keeps ignored files. `Ctrl+F` fetches remotes and refreshes the picker.

## cache-diagnostics

Use `/cache-debug` to investigate prompt-cache misses. Reports are saved under `~/.pi/agent/cache-diagnostics/reports/` without storing prompt content.

## clear-screen

Use `/clear-screen` to clear terminal output without changing the session.

## codex-priority

Automatically requests Fast mode for `gpt-6-luna` on `openai-codex`. Fast mode costs 2.5 times the standard rate. Do not combine it with another extension that changes `openai-codex` or `service_tier`.

## commit

Use `/commit` to group changes, review messages, and commit. `extensions.commit.push` controls pushing: `"ask"` by default, `true` to push automatically, or `false` to skip. Set `extensions.commit.avoidBreakingChanges` to `true` to omit `!` and `BREAKING CHANGE:` entries from generated messages. Pushing a branch without an upstream sets tracking on `origin`. Registered pre-commit checks run once first; failures stop the commit and go to the agent.

## cost-report

Use `/cost-report` to view spending for a chosen period and either the current project or all sessions. The HTML report opens automatically and is saved under `~/.pi/tau/cost-reports/`. Totals include decision-model spending.

## compaction

Tau automatically replaces long conversation history with a checkpoint so work can continue. Use `/compact` to do this manually. Configure `extensions.compaction.selfCompact` to change its thresholds. Settings changes require `/reload`.

Set `extensions.compaction.selfCompact.enabled` to `false` to disable self-compaction, including its tool, instructions, handoff recovery, and post-compaction model routing. Manual and automatic compaction then use Pi's built-in summary format and configured recent-token retention. Quick-model summary selection stays active in both modes. The footer continues showing context usage.

Each newly reached context stage is delivered once per checkpoint. Notice is informational and lets active work continue. Warning asks the agent to finish its current bounded work unit, then compact before starting another substantial unit.

At the hard cutoff, the agent must compact before using other tools. Failures are reported; a failed self-compaction keeps that restriction until a retry succeeds.

## decisions

Uses Jev or Luna to approve routine tool requests, remind the agent to answer questions first, and select a model for the work. Routing uses ChatGPT and Claude subscription logins; choosing a model yourself stops automatic routing for that session.

Bounded questions, investigation, fixes, and planning use Luna or Haiku under `quick`. Substantial engineering and ordinary architecture planning use Sol or Sonnet under `general`. Frontend and design within an established system prefer Sonnet, including whole pages. Opus is reserved for new design systems, fundamentally new interaction models, exceptional creative scope, or unusually difficult architecture with major unresolved constraints.

Peer candidates favor the less-used provider relative to an OpenAI-to-Anthropic target of 2:1 over a rolling 24 hours. This uses estimated costs recorded locally, not remaining subscription allowance. Configure `extensions.decisions.routing.balance.windowHours` and `balance.providerWeights` to adjust the target. Configure each route with a description and ordered `candidates`, each containing `provider`, `model`, and `thinking`; replace former route-level model settings with a candidates list. Settings changes require `/reload`.

Configure these features under `extensions.decisions`. Set `enabled` to `false` to disable them, or choose `auto`, `jev`, or `luna` for `classifier`. Missing credentials or failed decisions do not stop work.

## editor-border

Lets extensions display text in five slots across the editor's top and bottom borders. The footer places the context bar in the top-center slot; the session name appears in the footer.

## footer

Shows the model and thinking level, decision classifier, cache-hit rate, and costs in the first of two footer rows below the editor. The second row shows the working directory, git branch and changes, extension statuses, and session name. The context bar appears in the editor's top-center border slot. Use `/footer` to toggle it, `/footer on` or `/footer off` to set visibility, and `/footer refresh` to refresh it.

## handoff

Use `/handoff <goal>` to start a fresh linked session. Tau prepares a prompt with relevant project files and leaves it in the editor for you to review and send.

## ideas

Use `/ideas` to save ideas or browse saved ones.

## image-gen

Lets the agent generate and edit images with OpenAI or xAI. Run `/login openai-codex` or `/login xai` first. The tool follows the conversation's provider by default; you can ask for a different one. Generated images are saved for inspection.

## manage-sessions

Use `/manage-sessions` to browse saved sessions. `/sweep` starts a new session, then lets you archive or delete the previous one.

## md-lint

Automatically formats Markdown after edits, using your repository's Markdown lint configuration when present. Configure or disable it under `extensions.mdLint`.

Use `extensions.mdLint.ignoreGlobs` to leave reference trees alone; patterns ending in `/**` skip the entire directory. Custom lists replace the defaults. Read-only tools do not trigger scans.

## patch

Lets the agent create, edit, move, or delete several files in one operation. Used with OpenAI and OpenAI Codex; other providers use separate edit and write tools.

## qna

Use `/qna` to answer the agent's last questions in a form. It supports choices and typed answers. `/qna <context>` adds guidance for framing the questions. It runs only when you invoke it.

## ready

Use `/ready` to scan how well a repository supports agent work, including setup, checks, standards, and context. Choose a Markdown or HTML report, saved under `.pi/tau/ready/`. The scan does not score the repository.

## reference

Use `/reference` to manage separate repositories for comparison or inspiration. `/reference new <git-url>` adds one. Select references and explain why they matter; Tau puts their paths and your explanation in the editor for the agent.

## run-summary

Shows elapsed time and model cost after each run.

## runtime-context

Gives the agent the local date and a list of top-level project files and folders. This information refreshes after successful compaction.

## eval

Lets the agent run Python or Node.js code for calculations, data processing, and automation. Each call runs in a fresh process. You can expand the tool result to inspect its code and output. Requires `python3` or Node.js 22.6 or newer.

## silent-command-runner

Runs configured fixes after file changes and checks before the agent reports finished work. Configure commands under `extensions.silentCommandRunner.afterWrite`, `afterRun`, and `beforeCommit` (run once per `/commit`). Use `{files}` in an `afterWrite` command for the changed paths. Disable the extension through Pi's extension controls.

Scanning follows the configured globs; exclusions ending in `/**` skip entire directories. Missing or stale checks run automatically when applicable files changed during the run. Completed commands count as run even if they fail; failures are reported to the agent and do not independently trigger reruns.

## soul

Guides how Tau communicates, plans, and works. It also loads personal instructions from `~/.agents/AGENTS.md`. Use `/reload` after changing instruction files.

## stash

Press `Alt+S` to stash your prompt draft. Use `/pop` to browse drafts and restore one to the editor.

## tau-help

Use `/tau-help` to open this guide in the chat.

## tau

Use `/tau` for Tau setup, `/tau init [--global|--project]` to initialize it, and `/tau doctor` to check the installation. Unsupported Pi versions are reported with an installation command.

## tool-approval

Reviews the agent's shell and code requests before they run. Common read-only shell commands skip review; routine requests may be approved automatically. Sensitive actions, such as production changes, publishing, payments, or deleting valuable data, require your approval.

Set `extensions.toolApproval.autoApprove` to let approved requests run without another confirmation. In the approval panel, press `n` to attach a note to approval or rejection. Reject with a note when you want the agent to revise its request. If automatic review fails, Tau asks you to decide.

## tool-loader

Loads specialist tools when the agent needs them instead of including every tool in every request. Loading tools can cause a prompt-cache miss on some models.

## vocabulary

Injects only product term names and brief tool-discovery guidance from `.pi/tau/vocabulary.json` into the prompt. Definitions stay in the file and are available through the deferred tool. Ask the agent to look up or manage vocabulary. Before saving a change, discuss and agree on the product concept and definition. Terms are not collected automatically and should not describe implementation details. Changes to term names enter the prompt at the next agent run.

## web

Lets the agent search the web and fetch pages. Search uses an available Codex, Anthropic, or Grok login, with Exa as a fallback. Page fetching supports text and images, but not PDFs or other binary downloads.

## worktree

Use `/wt` to name a new worktree, copy your current checkout including unfinished edits, and continue in its own session. Tau converts the name to lowercase hyphenated form and creates its branch under `wt/`. The source checkout stays untouched. Checkouts containing nested Git repositories or initialized submodules are not supported.

Use `/wt list` to browse and switch worktrees. `/wt clean` previews unused, clean Tau worktrees and asks before removing them. Cleanup keeps branches and saved chats, warns before deleting ignored files, and skips dirty or occupied worktrees. Tau does not delete external worktree folders.

Opening an occupied checkout starts another chat there; concurrent edits and Git operations can interfere. Occupancy tracking from another machine expires after 24 hours, so it may not detect longer-running sessions there.

## Prompts

Prompt commands add instructions to your next request.

- `/cavemanify` requests short, blunt prose.
- `/implement` starts implementation of an approved change.
- `/interview` asks questions to clarify a request.
- `/plan-feature` explores a feature and plans the work.
- `/plan-implementation` turns an approved plan into implementation steps.
