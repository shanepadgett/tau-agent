# Write AGENTS.md

An `AGENTS.md` file gives Tau instructions that apply to every session in a folder, such as the test command or the code style.

1. For instructions that apply to one project, create `AGENTS.md` in the repository root:

   ```markdown
   Run the tests with `bun test`.
   Use tabs for indentation.
   ```

2. For instructions that apply to one part of a project, create `AGENTS.md` in that folder, such as `src/api/AGENTS.md`.
3. For instructions that apply to all your projects, create `~/.tau/AGENTS.md`. To share them with other agents that read the same folder, use `~/.agents/AGENTS.md`.

## What happens

- Before each model call, Tau reads `~/.agents/AGENTS.md`, then `~/.tau/AGENTS.md`, then each `AGENTS.md` from the repository root down to the session directory. Outside a git repository, it reads only the one in the session directory.
- Tau also tells the model today's date, the session directory, the operating system, and the files and folders two levels deep in the session directory (files that `.gitignore` excludes are left out).
- The first reading goes into the system prompt. When a file changes during a session, the model gets a note with the new text. A removed file gets a note that says so.
- The `AGENTS.md` file of a folder below the session directory loads the first time a script reads or changes a file in that folder.

## Limits

- Tau does not see files that a script reads with a shell command (`sh`), so those reads do not load the `AGENTS.md` of their folder.
- Tau does not read `CLAUDE.md`.
- The file list stops at 200 lines.
