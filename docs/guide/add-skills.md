# Add skills

A skill gives Tau the instructions, scripts and files for a particular task, such as filling in PDF forms. Tau reads skills in the [Agent Skills](https://agentskills.io/specification) format, so a skill written for another agent works unchanged.

1. For a skill of one project, create a folder named after the skill in `.agents/skills/` or `.tau/skills/` in the repository root, such as `.agents/skills/pdf-forms/`.
2. In that folder, create `SKILL.md` with a `name` that matches the folder and a `description` that says what the skill does and when to use it:

   ```markdown
   ---
   name: pdf-forms
   description: Fills in PDF forms. Use it when the user asks to fill in or check a PDF form.
   ---

   1. List the fields with `python scripts/fields.py <file>`.
   2. Fill them with `python scripts/fill.py <file> <values.json>`.
   ```

3. Put the files the skill names, such as `scripts/fill.py`, in the skill's folder.
4. For a skill of all your projects, put its folder in `~/.agents/skills/` or `~/.tau/skills/`. Use `~/.agents/skills/` to share it with other agents.
5. For a skill that only you start, add `disable-model-invocation: true` to the front matter. The model does not see it.

## What happens

- When a run starts, Tau reads `~/.agents/skills/`, `~/.tau/skills/`, then `.agents/skills/` and `.tau/skills/` in each folder from the repository root down to the session directory. When two skills have the same name, the one closest to the session directory wins.
- The system prompt lists the skills you use most, as `- name: description`, up to about 4,000 characters. Skills used in the same session directory and used recently count more. Before a skill has been used, project skills come first, then by name. The list ends with how many skills are not listed.
- The list keeps its order for the whole session. A skill added or removed during a session comes as a note at the next run.
- The model finds any skill with `search({ namespace: "skills", query: "..." })` in a `run` script, and loads one with `await tools.skills["pdf-forms"]()`. It gets the skill's folder path and the text of `SKILL.md` after the front matter.
- Tau counts each time a skill is loaded, in `~/.tau/sessions.db`.

## Limits

- A skill whose front matter is not valid YAML, or that has no `description`, is skipped, and Tau logs a warning. A skill whose `name` does not match its folder, or breaks the naming rules, loads with a warning.
- Tau uses `name`, `description` and `disable-model-invocation` from the front matter. It does not use `allowed-tools`, and you cannot start a skill yourself yet.
- Tau does not read `.claude/skills/`.
- A skill added while a run is going on is seen at the next run.
