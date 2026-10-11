# @shanepadgett/tau-agent

Tau is a custom agentic harness built with Pi extensions: tools, commands, prompts, skills, and themes.

The package also exports programmatic Tau capabilities for trusted Pi extensions. The built-in extensions and public API use the same underlying operations.

## Install

Requires stable Pi **1.1.0 or newer**. If Pi is not installed, install the minimum supported version (or a newer stable version):

```bash
npm install -g @earendil-works/pi-coding-agent@1.1.0
```

If a tool manager supplies Pi, keep any stable version at or above 1.1.0. Check `pi --version` in the directory where you launch Tau. Pi supplies the harness libraries; Tau does not install a separate copy. Startup and `/tau doctor` report unsupported versions when the Tau extension can load. Routine Tau releases and development dependency updates do not raise the Pi minimum.

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

Keep root Pi development dependencies exactly pinned and synchronized, independently of the published `>=1.1.0` peer minimums. Prefer safe capability-based fallbacks for newer APIs; raise the minimum only when required behavior cannot work safely on older supported hosts. If that happens, update both published packages and both installation guides together. `npm run check:package-sources` verifies that development pins satisfy aligned peer minimums before publishing. The runtime check reads the agent package's declared Pi peer range.

## Docs

- [Context management](./docs/context.md) — repository context structure and taxonomy
- [Extending Tau Agent](./docs/extending-tau-agent.md) — public events and integration
- [TUI](./docs/tui.md) — shared UI components
