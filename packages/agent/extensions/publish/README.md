# Publish

Create a tagged Tau release and monitor its GitHub Actions npm publish run.

## Usage

```text
/publish
```

`/publish` requires a clean Git working tree, authenticated GitHub CLI, and public approved npm package sources. It recommends a semantic version bump from commits since the previous release tag, asks for confirmation, then pushes a release tag. GitHub Actions publishes the TUI package before the agent package through npm trusted publishing.

If publishing fails, the agent runs read-only diagnostics and recommends a solution. It does not apply the fix or retry the release.
