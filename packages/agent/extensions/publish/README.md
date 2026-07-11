# Publish

Create a tagged Tau release and monitor its GitHub Actions npm publish run.

## Usage

```text
/publish
```

`/publish` requires a clean Git working tree and authenticated GitHub CLI. It recommends a semantic version bump from commits since the previous release tag, asks for confirmation, then pushes a release tag. GitHub Actions publishes the TUI package before the agent package through npm trusted publishing.
