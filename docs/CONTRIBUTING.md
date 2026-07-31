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
npm ci --ignore-scripts
mise run check
```

Run `npm ci --ignore-scripts` again after pulling changes to dependency declarations or `package-lock.json`.

Tau is a Pi package. Try the whole workspace with `pi -e .`, or only the agent package with `pi -e ./packages/agent`.

Extensions live in `packages/agent/extensions/`. Run `/reload` after changing an extension. Shared terminal UI components live in `packages/tui/src/`.

## Grammar artifacts

Explore's structural engine parses source code through WebAssembly. Most grammar `.wasm` files arrive prebuilt via npm dependencies; c_sharp, kotlin, and swift are committed at `packages/agent/src/ast/grammars/` and only need rebuilding when you bump their pins in `manifest.json` there.

Rebuilding on macOS requires a Docker-compatible container runtime — install [OrbStack](https://orbstack.dev/) or [Rancher Desktop](https://rancherdesktop.io/). A local wasm toolchain is neither required nor supported. Then:

```bash
mise run grammars:build
```

The host downloads the pinned toolchain and grammar sources; compilation runs offline inside the container. If your environment only allows images from a registry mirror, set `TAU_GRAMMAR_IMAGE` (default `node:24-trixie`), e.g. `TAU_GRAMMAR_IMAGE=<mirror-host>/node:24-trixie`.

On Linux the same task builds natively without a container. CI (`.github/workflows/grammars.yml`) rebuilds the artifacts and fails on byte drift, so a forgotten rebuild cannot land silently.

## Publishing

Both publishable packages use the same version. The TUI package publishes first because the agent depends on it.

For normal releases, start from a clean, pushed working tree and run `/publish` in Tau. It recommends a semantic version bump from commits since the previous `v*` tag, asks for confirmation, creates and pushes the release tag, then watches GitHub Actions publish:

1. `@shanepadgett/tau-tui`
2. `@shanepadgett/tau-agent`

GitHub Actions publishes through npm trusted publishing. The release workflow must stay at `.github/workflows/publish.yml`; npm trusted-publisher configuration names that file exactly.

The first release is different because npm has no package settings yet. Publish the TUI and agent locally, in that order, then configure trusted publishing for each package in npm before using `/publish` for later releases.
