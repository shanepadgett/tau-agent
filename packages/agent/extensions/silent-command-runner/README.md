# Silent Command Runner

Applies silent fixes after modifying tools finish and gives the agent `checks` for final repository verification. For runs that edit non-Markdown repository files, the agent must call it after all work is complete, immediately before its final summary, instead of running the registered checks manually. Skip the tool for Markdown-only edits, discussion, read-only investigation, and in-memory code execution that does not edit repository files. Markdown-only edits also skip automatic settlement checks; Markdown formatting runs separately. A write-capable tool call alone does not require checks. The system prompt and tool description both state this requirement and list configured check names, commands, and details. Automatic settlement checks are a safety net, not a substitute for the required tool call after non-Markdown file edits. The agent can call the tool directly or last in the same codemode script as its final edits, after awaiting all writes: `text(await tools.checks({}))`.

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

`afterWrite` commands run in array order only when matching file contents change. Use them for formatters and safe lint fixes. They finish before the tool result returns. An outer `codemode` call normally batches fixes, even if it runs several modifying tools. Calling `checks` inside it finishes pending fixes first; ending the script does not repeat those fixes unless later writes require them. Direct `patch`, `write`, `edit`, `bash`, `powershell`, and `eval` calls also trigger fixes, as do image tools and custom tools unless marked read-only.

Use the unquoted `{files}` placeholder to pass added or changed files as separate absolute-path arguments. Do not put it inside quotes. Deleted files are not passed. Commands without `{files}` run as written, so they can process the whole project. `includeGlobs` and `excludeGlobs` determine which changes trigger each command; they do not restrict what a project-wide command writes.

File scanning follows each command's globs and skips directories outside its scope. Exclusions ending in `/**` also skip that directory's entire subtree. Use narrow includes or subtree exclusions to avoid scanning downloaded repositories and large reference trees.

Fixer output and ordinary command failures stay out of the conversation. Configure corresponding read-only `afterRun` checks to report problems the fixers cannot resolve. `checks` takes no arguments and selects applicable checks from this array. Use a readable `name`, such as `Type checking`, and optional `details` to describe the check; `command` is the separate shell invocation. Results show names. The agent must not manually run configured checks or equivalent commands during development or final verification, including direct binaries, task-runner commands, wrappers, and alternate flags. Builds and relevant focused tests remain available when needed for the work in progress; a subset of a registered test suite is allowed, but full suites and other configured checks belong exclusively to `checks`.

Commands in `afterRun` and `beforeCommit` run in array order by default. To run independent, read-only commands concurrently, group them under `parallel`; the runner waits for every command in the group before moving to the next entry. It reports results in configuration order and still runs the rest of the group if one command fails. Use this only for commands that are safe to run at the same time. `afterWrite` fixers always run sequentially.

```json
{
  "extensions": {
    "silentCommandRunner": {
      "afterRun": [
        {
          "parallel": [
            { "name": "Lint", "command": "npm run lint" },
            { "name": "Type checking", "command": "npm run typecheck" }
          ]
        },
        { "name": "Integration checks", "command": "npm run integration-check" }
      ]
    }
  }
}
```

Successful tool output lists passed names: `The following checks passed: Lint, Type checking`. Failures return actionable output in the same tool result. The agent should fix reported problems directly, then call `checks` again. It should ask the user only if resolving a failure requires changing the check infrastructure itself. A completed call counts as current whether commands pass or fail. Output is bounded; complete overflow stays in a session-scoped temporary file referenced by the result.

Direct calls show the active check and its position in the tool row, then replace progress with the result. Calls inside codemode and automatic settlement checks show progress in a temporary widget that disappears when checks finish. Tool calls do not send separate progress or success notifications; automatic settlement checks still notify about passed checks.

In a run with non-Markdown file edits, any later write-capable tool call invalidates verification, even if it changes nothing, including later nested calls in the same codemode script. Reads through tools marked read-only preserve verification; `bash`, `eval`, and new `codemode` calls are conservatively write-capable. When the agent omits `checks` or its result is stale, applicable checks run automatically before settlement unless only Markdown files changed. Only this fallback posts a failure message and requests continuation. Automatic execution also counts as current, even on failure, so the agent's next response can settle without another run unless further writes invalidate it. Tau's ready-for-input notification waits until the run settles.

Applicable checks are selected from changed file contents, additions, or deletions covered by a configured check during the current run. Failures do not independently trigger reruns. Read-only shell commands and web-only codemode calls do not show check progress or run commands when they leave matching files unchanged in a run without edits.

Command objects in `afterWrite`, `afterRun`, and `beforeCommit` support `name`, `command`, `cwd` (relative to the project root), `env`, `details`, and `timeoutMs`. The first two also support `includeGlobs` and `excludeGlobs`; `beforeCommit` runs regardless of changed files. Commands default to a 120-second timeout and match all project files except generated/cache directories. `maxOutputBytes` controls each stream retained in expanded failure details; shared output limits bound the text sent to the agent. Remove an array entry to stop a command; use Pi's extension controls to disable the extension. The `checks` tool is registered and exposed only when `afterRun` contains runnable checks; if checks are removed during a loaded session, the tool is hidden. Run `/reload` after changing extension code or settings.

## Pre-commit checks

`beforeCommit` commands run once each time you run `/commit`, before Tau generates a commit plan. Every command runs regardless of which files changed. Ordinary entries run in array order; a `parallel` group starts its commands concurrently and finishes the whole group before the next entry. Use this list for checks such as the full test suite that would otherwise run once per commit in a Git `pre-commit` hook, because `/commit` can create several commits. If any command fails, `/commit` stops without committing and sends the failures to the agent to fix. Remove matching Git hooks yourself if you no longer want them; `/commit` still runs them.

```json
{
  "extensions": {
    "silentCommandRunner": {
      "beforeCommit": [
        {
          "parallel": [
            { "name": "Unit tests", "command": "npm test" },
            { "name": "Type checking", "command": "npm run typecheck" }
          ]
        }
      ]
    }
  }
}
```

Commands must not change files. If the working tree changes while they run, `/commit` stops. Only group commands that are safe to run concurrently.

## Reduce check-output tokens

Route your repository's checks through reporting scripts, then invoke those scripts from Mise, npm, or your task runner. Silent Command Runner runs arbitrary commands; your repository owns the tool-specific output handling.

Prefer each tool's structured output or a dedicated reporter. Emit compact, actionable failures: file locations, rule or error codes, explanations, and assertion differences. Remove passing results, banners, timings, and progress output before they reach the agent. This saves tokens without hiding what needs fixing.

Preserve failing exit codes and distinguish formatting differences from formatter errors. For unrecognized failures, emit an explicit fallback and retain the full output in a log referenced by the report. Do not discard unknown stderr or truncate before parsing. Keep successful checks quiet.

Markdown formatting remains provided by the separate `md-lint` extension.
