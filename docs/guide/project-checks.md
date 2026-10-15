# Project checks

`.tau/checks.json` at the repository root makes Tau format changed files and pass lint, types or tests before a run ends. It is read at the start of each run.

```json
{
  "fix": [{ "name": "format", "command": "bunx prettier --write {files}", "include": ["**/*.ts"] }],
  "check": [
    { "name": "types", "command": "bunx tsc --noEmit", "details": "Type checks the project." },
    { "name": "lint", "command": "bunx oxlint {files}", "include": ["src/**/*.ts"] }
  ]
}
```

| List | Runs |
| --- | --- |
| `fix` | After each `run` call that changed a matching file. The model never sees the output. |
| `check` | Through the model's `checks` tool, and by Tau when the model ends its turn unchecked |
| `commit` | In `/commit`, with `check` |

| Field | Does |
| --- | --- |
| `name`, `command` | Required. Exit code 0 passes. |
| `details` | Tells the model what the check does |
| `include`, `exclude` | Globs from the repository root (no `include` matches all) |
| `cwd`, `env` | Folder from the root, and variables to add |
| `timeoutSeconds` | Default 120 |

`{files}` is the full path of each changed file that still exists; a check that takes it does not run when only deleted files match.

Failures go back to the model 3 times, then the run ends naming the failing checks. A run also ends when the model stops after seeing checks fail, so it can ask you something. Outside Git, Tau cannot see changes: fixers do not run and every check runs once at the end. Tau runs a cloned repository's checks without asking.
