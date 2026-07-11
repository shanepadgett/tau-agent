# @shanepadgett/tau-agent

Tau is a custom agentic harness built with Pi extensions: tools, commands, prompts, skills, and themes.

## Install

```bash
pi install npm:@shanepadgett/tau-agent
# or from git (monorepo root)
pi install git:github.com/shanepadgett/tau-agent
# local
pi install ./path/to/tau-agent
pi install ./path/to/tau-agent/packages/agent
```

## Development

From the monorepo root:

```bash
npm install --ignore-scripts
mise run check
pi -e .
```

## Docs

- [Extending Tau Agent](./docs/extending-tau-agent.md) — public events and integration
- [Subagents](./docs/subagents.md) — custom agent definitions
- [TUI](./docs/tui.md) — shared UI components
