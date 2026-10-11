# md-lint

Formats Markdown files automatically. When a tool call changes a Markdown file, Tau runs markdownlint fixes with a packaged default ruleset, silently in the background. The agent keeps moving; nothing enters its context unless formatting fails.

The default ruleset ships with the package. A repository's own `.markdownlint-cli2.jsonc` overrides it, and `extensions.mdLint` settings control the extension: `enabled` (default `true`) and `ignoreGlobs` for Markdown paths to leave alone, with an extensive default ignore set (version-control directories, build outputs, and `.pi` session/cache directories).
