<!-- markdownlint-disable-next-line MD033 -->
<h1 align="center">Tau Agent</h1>
<!-- markdownlint-disable-next-line MD033 -->
<p align="center"><strong>The Complete Pi Package</strong></p>

Tau is a Pi package for people who want a coding agent that wastes less context and does less wandering. It replaces much of Pi's default working surface with tighter tools, a deliberate operating prompt, and focused TUI flows.

The agent prompt is Rok: direct, skeptical, careful with old code, and allergic to wrapper layers added for imaginary future callers. Tau keeps stable prompt material cacheable and collects project context once per session.

## Install

Install Tau from npm:

```bash
pi install npm:@shanepadgett/tau-agent
```

Or install directly from this repository:

```bash
pi install git:github.com/shanepadgett/tau-agent
```

Restart Pi or run `/reload` after installation.

## What Tau changes

- **Compact exploration tools** — Tau replaces `ls`, `find`, `grep`, and `read` with bounded output and focused reads. Less directory noise enters the model context.
- **One patch tool** — Multi-file edits use a structured patch format instead of separate write and edit wrappers.
- **Focused delegation** — `subagent` sends one bounded job to an isolated child session. Built-in `scout` and `web-research` keep the parent conversation small.
- **External references** — `/reference` keeps comparison repositories outside the working tree. Select one when it matters; Tau gives the agent the exact path and reason instead of letting it browse unrelated code.
- **Git flow** — `/commit` builds and reviews semantic commit groups.
- **Useful TUI flows** — Branch switching, session management, question panels, idea capture, stashed drafts, and status information live in Pi-native interfaces.
- **Web and visual work** — Compact web search/fetch/code-search tools, plus optional macOS window capture and image generation.

Run `/tau-help` inside Pi for the full extension list. Run `/tau init --global` or `/tau init --project` to set up Tau configuration.

## Packages

| Package | Purpose |
| --- | --- |
| `@shanepadgett/tau-agent` | Pi extensions, prompts, skills, themes, and schemas |
| `@shanepadgett/tau-tui` | Shared terminal UI components used by Tau extensions |

## Development

Contributor setup and release instructions: [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).
