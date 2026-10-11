# Silent Command Runner

Applies silent fixes after modifying tools finish and gives the agent `run_checks` for final repository verification. The agent must call it after all work is complete, immediately before its final summary, instead of running the registered checks manually. The system prompt and tool description both state this requirement and list configured check names, commands, and details. Automatic settlement checks are a safety net, not a substitute for the required tool call. The agent can call the tool directly or last in the same codemode script as its final edits, after awaiting all writes: `text(await tools.run_checks({}))`.

Configure it in Tau settings under `extensions.silentCommandRunner`:

```json
{
  "extensions": {
    "silentCommandRunner": {
      "afterWrite": [
        {
          "name": "Lint fixes",
          "command": "oxlint --fix {files}",
          "includeGlobs": ["src/**/*.ts"]
        },
        {
          "name": "Formatting fixes",
          "command": "oxfmt --write {files}",
          "includeGlobs": ["src/**/*.ts"]
        }
      ],
      "afterRun": [
        {
          "name": "Type checking",
          "command": "npm run typecheck",
          "details": "Checks TypeScript types without emitting files.",
          "includeGlobs": ["src/**/*.ts"]
        }
      ]
    }
  }
}
```

`afterWrite` commands run in array order only when matching file contents change. Use them for formatters and safe lint fixes. They finish before the tool result returns. An outer `codemode` call normally batches fixes, even if it runs several modifying tools. Calling `run_checks` inside it finishes pending fixes first; ending the script does not repeat those fixes unless later writes require them. Direct `patch`, `write`, `edit`, `bash`, `powershell`, and `script_runner` calls also trigger fixes, as do image tools and custom tools unless marked read-only.

Use the unquoted `{files}` placeholder to pass added or changed files as separate absolute-path arguments. Do not put it inside quotes. Deleted files are not passed. Commands without `{files}` run as written, so they can process the whole project. `includeGlobs` and `excludeGlobs` determine which changes trigger each command; they do not restrict what a project-wide command writes.

Fixer output and ordinary command failures stay out of the conversation. Configure corresponding read-only `afterRun` checks to report problems the fixers cannot resolve. `run_checks` takes no arguments and selects applicable checks from this array. Use a readable `name`, such as `Type checking`, and optional `details` to describe the check; `command` is the separate shell invocation. Results show names. The agent must not manually run configured checks or equivalent commands during development or final verification, including direct binaries, task-runner commands, wrappers, and alternate flags. Builds and relevant focused tests remain available when needed for the work in progress; a subset of a registered test suite is allowed, but full suites and other configured checks belong exclusively to `run_checks`.

Successful tool output lists passed names: `The following checks passed: Lint, Type checking`. Failures return actionable output in the same tool result so the agent can batch repairs and call `run_checks` again before summarizing the whole task. Output is bounded; complete overflow stays in a session-scoped temporary file referenced by the result.

Direct calls show the active check and its position in the tool row, then replace progress with the result. Calls inside codemode and automatic settlement checks show progress in a temporary widget that disappears when checks finish. Tool calls do not send separate progress or success notifications; automatic settlement checks still notify about passed checks.

Any later write-capable tool call invalidates verification, even if it changes nothing, including later nested calls in the same codemode script. Reads through tools marked read-only preserve verification; `bash`, `script_runner`, and new `codemode` calls are conservatively write-capable. When the agent omits `run_checks` or its result is stale, the same checks run automatically before settlement. Only this fallback posts a failure message and requests continuation. Tau's ready-for-input notification waits for verification and stays quiet while failures continue the run.

Both arrays support `name`, `command`, `cwd` (relative to the project root), `env`, `details`, `includeGlobs`, `excludeGlobs`, and `timeoutMs`. Commands default to a 120-second timeout and match all project files except generated/cache directories. `maxOutputBytes` controls each stream retained in expanded failure details; shared output limits bound the text sent to the agent. Remove an array entry to stop a command; use Pi's extension controls to disable the extension. The tool is hidden when `afterRun` is empty. Run `/reload` after changing extension code or settings.

## Reduce check-output tokens

Route your repository's checks through reporting scripts, then invoke those scripts from Mise, npm, or your task runner. Silent Command Runner runs arbitrary commands; your repository owns the tool-specific output handling.

Prefer each tool's structured output or a dedicated reporter. Emit compact, actionable failures: file locations, rule or error codes, explanations, and assertion differences. Remove passing results, banners, timings, and progress output before they reach the agent. This saves tokens without hiding what needs fixing.

Preserve failing exit codes and distinguish formatting differences from formatter errors. For unrecognized failures, emit an explicit fallback and retain the full output in a log referenced by the report. Do not discard unknown stderr or truncate before parsing. Keep successful checks quiet.

Markdown formatting remains provided by the separate `md-lint` extension.
