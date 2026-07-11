# tau-agent

Tau is a custom agentic harness built with Pi extensions.

## Packages

| Package | npm name | Role |
| --- | --- | --- |
| `packages/agent` | `@shanepadgett/tau-agent` | Pi package: extensions, prompts, skills, themes |
| `packages/tui` | `@shanepadgett/tau-tui` | Shared TUI components |

## Development

```bash
npm install --ignore-scripts
mise run check
```

## Try locally

```bash
pi -e .
# or agent package only
pi -e ./packages/agent
```

## Install

```bash
pi install npm:@shanepadgett/tau-agent
pi install git:github.com/shanepadgett/tau-agent
pi install ./path/to/tau-agent
```
