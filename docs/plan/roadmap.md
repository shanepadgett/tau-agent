# Roadmap

Status: snapshot of 2026-10-14. A one-page view of what Tau does today, what comes next, and what is only an idea. The details live in the files linked from [README.md](README.md).

## Where we are

Tau is built in eight steps ([architecture.md](architecture.md#build-order)). Steps 1–5 are built; step 6, the terminal chat, is part done.

```mermaid
flowchart LR
  S1["1 Storage ✓"] --> S2["2 Models ✓"] --> S3["3 Sessions ✓"] --> S4["4 Agent loop ✓"] --> S5["5 Long sessions ✓"]
  S5 --> S6["6 Terminal chat — 6a ✓, 6b and 6c next"] --> S7["7 Extensions"] --> S8["8 Install and updates"]
```

## Built

| Area | What the user can do | Guide |
| --- | --- | --- |
| Log in | Save an API key or a subscription login for Anthropic, OpenAI, ChatGPT, Codex, OpenRouter or OpenCode Go | [log-in](../guide/log-in.md) |
| Models | Pick a model with `--model` or in settings; Tau retries rate limits and says when a plan limit resets | [choose-a-model](../guide/choose-a-model.md), [rate-limits](../guide/rate-limits.md) |
| Settings | `~/.tau/settings.json`: model, run limits, extra providers, `AGENTS.md` on or off | [settings](../guide/settings.md) |
| Print mode | `tau -p "fix the failing test"` runs one prompt and exits | [print-mode](../guide/print-mode.md) |
| Chat | `tau` opens a chat: streamed answers, each script shown, cancel, queued prompts, resume a session, select text to copy | [chat](../guide/chat.md) |
| Tools | The model has two tools: `run` (a JavaScript script that calls shell, file and search functions) and `checks`. A failed script is fixed with small edits; long output is saved to a file | — |
| Project checks | `.tau/checks.json` formats changed files and makes lint, types or tests pass before a run ends | [project-checks](../guide/project-checks.md) |
| Instructions | `AGENTS.md`, instruction files (always on, or read when a situation applies), skills | [write-agents-md](../guide/write-agents-md.md), [write-instruction-files](../guide/write-instruction-files.md), [add-skills](../guide/add-skills.md) |
| Long sessions | A cheap model writes notes on older entries in the background; the agent checkpoints with a handoff; older notes fold into a session memory | [checkpoints](../guide/checkpoints.md) |
| Process sessions | The agent leaves a dev server, watcher or REPL running and comes back to it | [process-sessions](../guide/process-sessions.md) |
| Reload | When Tau's own code changes, the chat restarts into it once idle; broken code shows above the input | [chat](../guide/chat.md) |
| Diagnostics | Each session writes a log under `~/.tau/logs` | — |

Built underneath but not reachable by the user yet: branching a session (storage only) and decision models (the AI layer has them; nothing calls them).

## Next, in order

| # | Work | Plan |
| --- | --- | --- |
| 1 | Messages: give every remaining Tau message one home (chat, status strip or log) | [work/messages.md](work/messages.md) |
| 2 | Simulation mode: the real chat on a scripted `sim` model, so screens are reviewed without paying for model calls | [features.md](features.md#interface) |
| 3 | 6b, sidebar: context use, running processes, compaction state, cost | [work/tui.md](work/tui.md) |
| 4 | Decide multi-repository sessions, because the session picker depends on it | [features.md](features.md#context) |
| 5 | 6c, commands: `/model`, session picker, `/compact`, `/settings`, login | [work/tui.md](work/tui.md) |
| 6 | Step 7: the extension SDK (`@shanepadgett/tau`), then rebuild the built-ins from `main` on it | [sdk.md](sdk.md) |
| 7 | Step 8: packages, install, updates | [sdk-packages.md](sdk-packages.md) |

The built-ins planned for step 7: md-lint, attention, commit, auto-name, branch, cost-report, stash, tool-approval, web, image-gen, worktree, run-summary, qna, handoff, reference, aside, manage-sessions.

## Agreed, but not scheduled

| Feature | What it does |
| --- | --- |
| Steering messages | A message sent mid-run reaches the agent at the next step, instead of waiting for the run to end |
| Prompt classifier | One cheap model call per prompt picks the route, flags off-topic prompts, and suggests functions and skills |
| Prompt files | Reusable prompts with `$1`, `$ARGUMENTS` and code blocks that run when the file is used |
| Deferred functions | Extension functions stay hidden until the model searches for them |
| Branching and reset in the chat | Branch from an earlier entry; start fresh from a handoff |
| Custom messages | The user or an extension adds a message, and chooses whether it starts a turn |
| Cache miss warnings | The chat warns when a model call re-bills tokens that should have come from the prompt cache, with the cost and the likely cause |

## Ideas, not decided

Multi-repository sessions, cache warnings, a 1-hour cache setting, asking to compact when the cache is cold, a live inspector (`tau observe`), a system prompt view, HTML export, a question tracker. Each is described in [features.md](features.md); later decisions are in [deferred.md](deferred.md).

## Waiting on you

Twelve live checks with real models are open in [live-checks.md](live-checks.md). They cover script edits, instruction files, project checks, output limits, reload and diagnostics. Several finished work plans stay in `work/` until their live checks pass.
