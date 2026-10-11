# Silent Command Runner

Applies silent fixes after modifying tools finish, then runs read-only checks before the agent run settles. Tau tells the agent which commands are automatic so it does not run them manually.

Configure it in Tau settings under `extensions.silentCommandRunner`:

```json
{
  "extensions": {
    "silentCommandRunner": {
      "afterWrite": [
        {
          "name": "lint-fix",
          "command": "oxlint --fix {files}",
          "includeGlobs": ["src/**/*.ts"]
        },
        {
          "name": "format",
          "command": "oxfmt --write {files}",
          "includeGlobs": ["src/**/*.ts"]
        }
      ],
      "afterRun": [
        {
          "name": "check",
          "command": "npm run check",
          "includeGlobs": ["src/**/*.ts"]
        }
      ]
    }
  }
}
```

`afterWrite` commands run in array order only when matching file contents change. Use them for formatters and safe lint fixes. They finish before the tool result returns. An outer `codemode` call is one boundary, even if it runs several modifying tools. Direct `patch`, `write`, `edit`, `bash`, `powershell`, and `script_runner` calls also trigger fixes, as do image tools and custom tools unless marked read-only.

Use the unquoted `{files}` placeholder to pass added or changed files as separate absolute-path arguments. Do not put it inside quotes. Deleted files are not passed. Commands without `{files}` run as written, so they can process the whole project. `includeGlobs` and `excludeGlobs` determine which changes trigger each command; they do not restrict what a project-wide command writes.

Fixer output and ordinary command failures stay out of the conversation. Configure corresponding read-only `afterRun` checks to report problems the fixers cannot resolve. Check passes are notifications only. Failures post one Tau message with stdout/stderr tail output and continue the agent run. Tau's ready-for-input notification waits for these checks and stays quiet when a failure continues the run.

Both arrays support `name`, `command`, `cwd` (relative to the project root), `env`, `details`, `includeGlobs`, `excludeGlobs`, and `timeoutMs`. Commands default to a 120-second timeout and match all project files except generated/cache directories. `maxOutputBytes` controls failure output sent to the agent. Remove an array entry to stop a command; use Pi's extension controls to disable the extension. Run `/reload` after changing extension code or settings.

Markdown formatting remains provided by the separate `md-lint` extension.
