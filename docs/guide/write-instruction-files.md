# Write instruction files

An instruction file gives Tau instructions that are either always in the system prompt or read only when their situation applies, such as the steps of a release.

1. For instructions that apply to one project, create a Markdown file in `.tau/instructions/` in the repository root. The file name is the instruction file's name, such as `.tau/instructions/release.md`.
2. Start the file with front matter. For instructions the model needs in every session, set `always: true`:

   ```markdown
   ---
   always: true
   ---

   Use tabs for indentation.
   ```

3. For instructions the model needs only in some situations, set `read-when` to the situation in which to read the file:

   ```markdown
   ---
   read-when: When you prepare a release or change the version number.
   ---

   1. Update CHANGELOG.md.
   2. Run `bun run release`.
   ```

4. For instructions that apply to one part of a project, put the file in `.tau/instructions/` in that folder, such as `src/api/.tau/instructions/errors.md`.
5. For instructions that apply to all your projects, put the file in `~/.tau/instructions/`.

## What happens

- Before each model call, Tau reads `~/.tau/instructions/`, then `.tau/instructions/` in each folder from the repository root down to the session directory. Outside a git repository, it reads only the session directory.
- The text of each `always: true` file goes into the system prompt inside an `<instructions path="…">` tag that names the file.
- Each file with `read-when` is listed in the system prompt as `- name (path): read-when`. The model reads the file itself when that situation applies.
- When two files have the same name, the one in the folder closest to the session directory wins.
- When a file changes during a session, the model gets a note with the new text or the new list. A file that is removed, or that is no longer `always: true`, gets a note that its instructions no longer apply.

## Limits

- A file without front matter, with front matter that is not valid YAML, or with neither `always: true` nor `read-when` is skipped, and Tau logs a warning.
- Tau reads only files that end in `.md`, and does not look in subfolders of `.tau/instructions/`.
- Tau does not read `.claude/` or `CLAUDE.md`.
