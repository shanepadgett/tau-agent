# @shanepadgett/tau-agent

Tau is a custom agentic harness built with Pi extensions: tools, commands, prompts, skills, and themes.

The package also exports programmatic Tau capabilities for trusted Pi extensions. The built-in extensions and public API use the same underlying operations.

## Install

```bash
pi install npm:@shanepadgett/tau-agent
# or from git (monorepo root)
pi install git:github.com/shanepadgett/tau-agent
# local
pi install ./path/to/tau-agent
pi install ./path/to/tau-agent/packages/agent
```

## Programmatic use

Install the package in the extension's project, then import from its root:

```ts
import { generateImage } from "@shanepadgett/tau-agent";

const image = await generateImage(ctx, {
  prompt: "A quiet mountain lake",
  path: "assets/lake.png",
  signal,
});
```

See [Extending Tau Agent](./docs/extending-tau-agent.md) for the supported API.

## Development

From the monorepo root:

```bash
npm install --ignore-scripts
mise run check
pi -e .
```

## Docs

- [Context management](./docs/context.md) — repository context structure and taxonomy
- [Extending Tau Agent](./docs/extending-tau-agent.md) — public events and integration
- [Subagents](./docs/subagents.md) — custom agent definitions
- [TUI](./docs/tui.md) — shared UI components
