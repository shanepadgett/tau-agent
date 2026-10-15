# Tau

A coding agent for the terminal. You chat with a model that works in your project by writing and running scripts: it reads and edits files, runs shell commands, searches the web and runs your project's checks. Tau runs on Bun, Effect and OpenTUI and is not released yet; you run it from source.

## Set up

1. Install [mise](https://mise.jdx.dev/getting-started.html), then [activate it in your shell](https://mise.jdx.dev/installing-mise.html#shell-setup).
2. In this repository, trust the config and install the pinned tools (Bun and Node):

   ```sh
   mise trust
   mise install
   ```
3. Install dependencies (this also patches the TypeScript compiler):

   ```sh
   mise run setup
   ```
4. Log in to a provider and set a model (see [docs/guide/quickstart.md](docs/guide/quickstart.md)):

   ```sh
   mise run login
   ```
5. Open the chat:

   ```sh
   mise run dev
   ```

## Develop

Tau develops itself. `mise run dev` watches `src/`, builds each change, checks that it starts, and restarts the chat into it on the same session. Set `"autoRestart": false` in `~/.tau/settings.json` to restart only with `/restart`. If new code fails, the old code keeps running and the status strip shows why.

| Command | Does |
| --- | --- |
| `mise run setup` | Install dependencies |
| `mise run login`, `mise run logout` | Save or remove a provider login |
| `mise run dev` | Chat from source, restarting on changes. Tau arguments go after `--`: `mise run dev -- -p "prompt"` |
| `mise run check` | Every read-only check: format, lint, types, dead code, duplicates, tests |
| `mise run test:all` | Every application test |
| `mise run test:binary` | Compiled-binary tests |
| `mise run fix:fmt -- <files>` | Format files |
| `mise run fix:lint -- <files>` | Apply safe lint fixes |
| `mise run gallery` | Design gallery for new front-end work |
| `mise run docs` | Refresh dependency docs in `docs/reference/copies/` after a version change |
| `mise tasks` | List all tasks |

`src/` has one folder per layer: `cli`, `tui`, `core` (agent loop, tools), `ai` (providers, models), `session`, `database`, `host`, `proc`, `sandbox`, `supervisor`, `workspace`. Tests are in `tests/`.

## Docs

- [docs/guide/](docs/guide/): using Tau.
- [docs/plan/roadmap.md](docs/plan/roadmap.md): what is left to build.
- [docs/standards/](docs/standards/) and [AGENTS.md](AGENTS.md): rules for code, plans and docs. Agents working in this repository read them.

## License

[MIT](LICENSE)
