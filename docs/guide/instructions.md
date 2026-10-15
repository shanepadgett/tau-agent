# Instructions and skills

Tau reads these before each model call and tells the model when one changes. It never reads `CLAUDE.md` or `.claude/`. Outside Git only the launch folder is read; the closest folder wins a name clash.

| Kind | Where | Loaded |
| --- | --- | --- |
| `AGENTS.md` | `~/.agents/`, `~/.tau/`, then each folder from the repository root down to the launch folder | In the system prompt. A subfolder's loads when a script first reads or changes a file there. |
| Instruction files | `~/.tau/instructions/*.md`, then `.tau/instructions/*.md` in each folder from the root down | `always: true`: in the system prompt. `read-when`: listed, and the model reads the file when it applies. |
| Skills | `~/.agents/skills/`, `~/.tau/skills/`, then `.agents/skills/`, `.tau/skills/` in each folder from the root down | Listed by use; the model loads one when needed |

`"agentsFiles": false` turns off every `AGENTS.md`.

## Instruction files

```markdown
---
read-when: When you prepare a release or change the version number.
---

1. Update CHANGELOG.md.
```

Use `always: true` instead of `read-when` for text needed every session. A file without valid front matter or either key is skipped, with a warning in the status strip.

## Skills

The [Agent Skills](https://agentskills.io/specification) format. Create `<skills folder>/pdf-forms/SKILL.md`; files it names sit beside it.

```markdown
---
name: pdf-forms
description: Fills in PDF forms. Use it when the user asks to fill in or check a PDF form.
---

1. List the fields with `python scripts/fields.py <file>`.
```

`name` should match the folder. `disable-model-invocation: true` hides it from the model. Tau uses only those three keys, and you cannot start a skill yourself yet. A skill without a `description` or with bad front matter is skipped with a warning.
