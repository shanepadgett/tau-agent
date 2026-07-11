# Contributing

## Development

Install [Mise](https://mise.jdx.dev/):

```bash
curl https://mise.run | sh
```

Activate it for your shell, then open a new terminal:

```bash
# zsh
echo 'eval "$(~/.local/bin/mise activate zsh)"' >> ~/.zshrc

# bash
echo 'eval "$(~/.local/bin/mise activate bash)"' >> ~/.bashrc

# fish
mkdir -p ~/.config/fish
echo '~/.local/bin/mise activate fish | source' >> ~/.config/fish/config.fish
```

Clone the repository, then trust its Mise configuration before installing anything:

```bash
mise trust
mise install
npm install --ignore-scripts
mise run check
```

Tau is a Pi package. Try the whole workspace with `pi -e .`, or only the agent package with `pi -e ./packages/agent`.

Extensions live in `packages/agent/extensions/`. Run `/reload` after changing an extension. Shared terminal UI components live in `packages/tui/src/`.

## Publishing

Both publishable packages use the same version. The TUI package publishes first because the agent depends on it.

For normal releases, start from a clean, pushed working tree and run `/publish` in Tau. It recommends a semantic version bump from commits since the previous `v*` tag, asks for confirmation, creates and pushes the release tag, then watches GitHub Actions publish:

1. `@shanepadgett/tau-tui`
2. `@shanepadgett/tau-agent`

GitHub Actions publishes through npm trusted publishing. The release workflow must stay at `.github/workflows/publish.yml`; npm trusted-publisher configuration names that file exactly.

The first release is different because npm has no package settings yet. Publish the TUI and agent locally, in that order, then configure trusted publishing for each package in npm before using `/publish` for later releases.
