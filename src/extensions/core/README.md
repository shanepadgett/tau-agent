# Core Extension

Always-on Tau behavior bundled as one Pi extension.

## Modules

- `src/attention`: terminal-driven notification when Tau is ready for input.
- `src/commit`: `/commit` command for generating, reviewing, and committing all current git changes.

## Layout

Core has one Pi entrypoint, `index.ts`. Feature modules live under `src/<module>` and expose register functions called by the core entrypoint.
