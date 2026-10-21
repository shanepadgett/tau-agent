# Reference

Attach local reference repositories to a conversation so Tau knows where to find read-only examples.

## Usage

```text
/reference
/reference new <git-url>
```

## Behavior

- Stores references in `~/.local/share/tau-agent/references/`.
- `/reference` opens a TUI picker with this conversation's attached references checked.
- The picker shows each repository's name with its `origin` owner in muted parentheses when available, falling back to its local folder name.
- `Ctrl+N` adds a new reference from a git URL, showing clone progress in the list as `↓ 37%`.
- New references clone the remote default branch.
- `Ctrl+B` switches the highlighted reference to another branch.
- `Ctrl+U` runs `git pull --ff-only --quiet` in the visible references without closing the picker, showing `…`, `✓`, or `!` next to each name.
- `Ctrl+O` opens the highlighted reference in an editor. Defaults to `$VISUAL`, `$EDITOR`, then `code`; settings can force `code` or `zed`.
- `Ctrl+D` deletes the selected references, or the highlighted reference if none are selected, from disk after confirmation.
- `/` filters references by name, branch, or path. Enter applies the filter; Esc clears/closes it.
- Space toggles attachments; Enter saves the complete selection. Save with nothing checked to detach all references. Esc cancels attachment edits; completed Git and disk actions are not undone.
- Saving leaves your prompt draft alone and does not start an agent turn. Tau receives the attached names, paths, and read-only usage guidance on the next agent run, without loading repository contents.
- Attachments belong to the conversation branch, survive reopening and compaction, and follow conversation forks. New chats start without attachments.
- Missing reference folders remain listed and checked until you uncheck them and save.

## Settings

```json
{
  "extensions": {
    "reference": {
      "editor": "default",
      "branchChoices": 5
    }
  }
}
```

`editor` can be `default`, `code`, or `zed`.
`branchChoices` controls how many branches are shown when switching branches.

## Limits

- Requires TUI mode for the picker.
- `/reference new <git-url>` works without the reference picker.
- Uses the git URL basename as the folder name.
- Pi saves a new chat after its first message. Closing it before sending that message discards any attachment selections.
- References are treated as read-only examples by the agent's instructions.
- Updating or switching a reference's Git branch changes the shared local checkout for every chat using it; attachments do not pin repository versions.
