# Add project checks

Project checks let Tau format the files the model changes and make sure lint, type checks or tests pass before a run ends.

1. Create `.tau/checks.json` in the repository root. Outside a git repository, create it in the session directory.
2. Add the commands that fix files, such as a formatter, to the `fix` list. Write `{files}` where the command takes the changed files:

   ```json
   {
     "fix": [{ "name": "format", "command": "bunx prettier --write {files}", "include": ["**/*.ts"] }]
   }
   ```

3. Add the commands that check the project to the `check` list. Use `details` to tell the model what a check does:

   ```json
   {
     "check": [
       { "name": "types", "command": "bunx tsc --noEmit", "details": "Type checks the project." },
       { "name": "lint", "command": "bunx oxlint {files}", "include": ["src/**/*.ts"] }
     ]
   }
   ```

4. Set the other fields of a check when you need them:
   - `include` and `exclude`: globs that match paths from the repository root. With no `include`, every path matches.
   - `cwd`: the folder the command runs in, from the repository root. The default is the repository root.
   - `env`: environment variables to add, such as `{ "CI": "1" }`.
   - `timeoutSeconds`: how long the command can run. The default is 120.

## What happens

- Tau reads `.tau/checks.json` at the start of each run. A change to the file applies from the next prompt.
- After each `run` call, Tau compares `git status` and the content of the changed files with what they were before the call, so it finds changes made through `sh` too.
- Fixers run after each `run` call that changed a file they match. The model does not see their output; large output is saved in a private temporary file.
- When the project has `check` commands, the model gets a `checks` tool. It runs the checks that match the files changed since the user's prompt, and gives the model each check that passed and the output of each that failed.
- When the model ends its turn and the changed files have no passing checks after the last change, Tau runs the checks itself and sends failures back to the model.
- A check passes when its command exits with code 0. `{files}` gives the command the full path of each changed file that still exists.
- Outside a git repository, Tau cannot see which files changed. Fixers do not run, the `checks` tool runs every check, and Tau runs every check once at the end of a run that had a `run` call.

## Limits

- After Tau sends failed checks back 3 times, the run ends and names the checks that still fail. In print mode, Tau exits with an error.
- A check that matches only deleted files and takes `{files}` does not run.
- A fixer that fails is ignored.
- Check output and combined reports over 50 KB (51,200 bytes) or 2,000 lines keep half at the start and half at the end. Cut notes link to private output files in `$TMPDIR/tau/<session>/` (see [print-mode.md](print-mode.md)). Each command's file keeps its whole received output; a combined-report file keeps the report, including links to command logs. Saved sessions replay the same preview text.
- Tau reads the `commit` list but does not run it yet.
- A checks file that is not valid JSON, or has a wrong field, fails the run and names the problem. Fix the file, or remove it.
- Tau runs the commands in a cloned repository's checks file without asking.
