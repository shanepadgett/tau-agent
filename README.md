<!-- markdownlint-disable-next-line MD033 -->
<h1 align="center">τau Agent</h1>

A [Pi](https://github.com/earendil-works/pi) package for coding with less wasted context. Tau adds a working prompt, focused source exploration, and automatic checks that send failures—not successful command logs—to the agent.

## Install

Requires **Node.js 22.19+** and **Pi 1.0.4 exactly**.

Install the supported Pi version first:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.0.4
```

Then install Tau using **one** of these options.

### From npm

```bash
pi install npm:@shanepadgett/tau-agent
```

### From GitHub

```bash
pi install git:github.com/shanepadgett/tau-agent
```

## What saves context

- **[Soul](packages/agent/extensions/soul/README.md)** supplies the agent's working instructions: direct communication, explicit planning, scoped changes, and focused tool use. Stable instructions stay in place across turns; updates append where the model supports it, preserving the cached prompt prefix.
- **[Silent Command Runner](packages/agent/extensions/silent-command-runner/README.md)** runs your configured checks after matching edits. Passing output stays out of the conversation. Failures send the agent the command output so it can fix the problem.
- **[Explore](packages/agent/extensions/explore/README.md)** reads source structure: declaration outlines, selected bodies, imports, and callers. Large supported files return an outline by default rather than their entire contents. Pi keeps `ls`, `find`, `grep`, and `read`; Explore adds focused ways to inspect code.
- **[Tool Loader](packages/agent/extensions/tool-loader/README.md)** keeps specialist tool definitions out of ordinary coding requests. Image and macOS tools load when needed; web tools run through code mode so the agent can filter results before they enter context. Cache preservation when loading tools depends on the model.
- **[Script Runner](packages/agent/extensions/script-runner/README.md)** runs custom Python, Node.js, and Deno code using installed runtimes. Failed scripts can be retried with targeted edits rather than sending the whole script again.

[Compaction](packages/agent/extensions/compaction/README.md) also reduces summary costs by using a cheaper model from the same provider when one fits, falling back to Pi's default compaction otherwise.

## Set up automatic checks

Tau works with defaults, but automatic checks need your project's commands. Run `/tau init --project` to create `.pi/tau/settings.json`, then add a command under `extensions`:

```json
{
  "extensions": {
    "silentCommandRunner": {
      "commands": [
        {
          "name": "typecheck",
          "command": "npm run typecheck",
          "includeGlobs": ["src/**/*.ts"]
        }
      ]
    }
  }
}
```

Use a command and file patterns that match your project, and keep the generated `$schema` field. Run `/trust` if the project is not yet trusted, then `/reload` to load the settings. Tau tells the agent which checks run automatically so it does not repeat them manually.

For settings shared across projects, use `/tau init --global`. See the [Silent Command Runner guide](packages/agent/extensions/silent-command-runner/README.md) for more configuration.

## Other useful commands

| Command | Purpose |
| --- | --- |
| `/review` | Run a separate simplify, architecture, or correctness review without adding the report to the coding conversation. |
| `/aside <question>` | Ask a one-off question without adding the question or answer to the conversation. |
| `/context` | Select reusable project context from `.pi/contexts`. |
| `/handoff <goal>` | Prepare a fresh linked session with an opening prompt you can review. |
| `/commit` | Group, review, and commit selected Git changes. |
| `/reference` | Manage comparison repositories outside the working tree. |
| `/worktree` | Create and resume isolated feature workspaces and their sessions. |

Tau also includes session management, question panels, web research, image generation, and optional macOS window capture. The [command guide](packages/agent/extensions/tau-help/help.md) covers the full set.

**Codex pricing:** Tau requests Fast mode for `gpt-6-luna` on `openai-codex`, including background work. This uses OpenAI's 2.5× Fast mode rate. See [Codex Priority](packages/agent/extensions/codex-priority/README.md).

## Documentation

- [Project context](packages/agent/docs/context.md) — organize reusable repository context.
- [Extending Tau](packages/agent/docs/extending-tau-agent.md) — public APIs and integration.

## Development

To work on Tau itself, see [Contributing](docs/CONTRIBUTING.md) for local development setup and release instructions.

This repository publishes `@shanepadgett/tau-agent` and `@shanepadgett/tau-tui`, the shared terminal UI components used by Tau extensions.

[MIT license](LICENSE).
