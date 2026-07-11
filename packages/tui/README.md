# @shanepadgett/tau-tui

Shared terminal UI components and helpers for Tau Agent extensions.

Use these when Pi built-ins (`ctx.ui.select`, `SelectList`, …) are not enough and you need custom panels, lists, tabs, markers, or key-hint footers that match Tau’s look.

## Install

```bash
npm install @shanepadgett/tau-tui
```

Peer dependencies: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`.

## Usage

```ts
import { ToolPanel, SelectableList, bindingHint } from "@shanepadgett/tau-tui";
```

Authoring guidance for Tau Agent lives in the agent package docs (`docs/tui.md`).
