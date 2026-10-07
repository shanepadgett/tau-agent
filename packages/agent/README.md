# @shanepadgett/tau-agent

Tau is a custom agentic harness built with Pi extensions: tools, commands, prompts, skills, and themes.

The package also exports programmatic Tau capabilities for trusted Pi extensions. The built-in extensions and public API use the same underlying operations.

## Install

This release supports Pi **1.0.4** exactly. Install that harness version before installing Tau:

```bash
npm install -g @earendil-works/pi-coding-agent@1.0.4
```

If a tool manager supplies Pi, set its Pi version to 1.0.4 instead. Check `pi --version` in the directory where you launch Tau. Pi supplies the harness libraries; Tau does not install a separate copy. Startup and `/tau doctor` report version mismatches when the Tau extension can load.

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

When updating Pi, change the root development dependency pins and the Pi peer pins in both published packages together, then update the installation examples. `npm run check:package-sources` verifies the pins before publishing. The runtime check reads the agent package's declared Pi peer version.

## Docs

- [Context management](./docs/context.md) — repository context structure and taxonomy
- [Extending Tau Agent](./docs/extending-tau-agent.md) — public events and integration
- [TUI](./docs/tui.md) — shared UI components
