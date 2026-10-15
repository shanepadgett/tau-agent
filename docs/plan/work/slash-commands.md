# Slash command suggestions

Status: built 2026-10-14. The user approved the mockup.

**Decision:** while the input holds `/` and a word with no space, a list of the matching commands shows directly above the input, in the place the `/model` picker uses. Up and Down move, Tab and Enter both put the chosen command in the input and close the list without sending it, and Escape closes the list. Asked for by the user.

## Mockup

Today, typing `/se` shows nothing until Enter:

```text
│ …transcript…                                                       │
│ ✓ bun test tests/tui                                               │
├────────────────────────────────────────────────────────────────────┤
│ /se█                                                               │
└────────────────────────────────────────────────────────────────────┘
  anthropic/claude-sonnet-5-5 · 42k/200k · $0.04   enter send · shift+enter new line · ctrl+d quit
```

After. Typing `/` lists every command, the first one selected:

```text
│ …transcript…                                                       │
┌ Commands ──────────────────────────────────────────────────────────┐
│ ▸ /model     Change the model for this chat                        │
│   /new       Start a new session in this folder                    │
│   /restart   Restart Tau into new code                             │
│   /sessions  Open an earlier session of this folder                │
└────────────────────────────────────────────────────────────────────┘
├────────────────────────────────────────────────────────────────────┤
│ /█                                                                 │
└────────────────────────────────────────────────────────────────────┘
  anthropic/claude-sonnet-5-5 · 42k/200k · $0.04   ↑↓ move · tab/enter complete · esc close
```

Typing `/se` filters the list to the commands that start with it:

```text
┌ Commands ──────────────────────────────────────────────────────────┐
│ ▸ /sessions  Open an earlier session of this folder                │
└────────────────────────────────────────────────────────────────────┘
│ /se█                                                               │
```

Tab or Enter puts the command in the input and closes the list; the next Enter sends it:

```text
│ /sessions█                                                         │
└────────────────────────────────────────────────────────────────────┘
  anthropic/claude-sonnet-5-5 · 42k/200k · $0.04   enter send · shift+enter new line · ctrl+d quit
```

No command matches `/xyz`: the list is gone, and Enter sends the text as a prompt, as today.

During a run, the list sits between the run panel and the input; the status strip, when it shows, stays above the list:

```text
│ ○ Running…                                                         │
│ Queued: fix the lint errors                                        │
│ ! Skipped the skill /work/.agents/skills/pdf-forms/SKILL.md: …     │
┌ Commands ──────────────────────────────────────────────────────────┐
│ ▸ /restart   Restart Tau into new code                             │
└────────────────────────────────────────────────────────────────────┘
│ /re█                                                               │
```

While the list shows, Tab completes instead of queuing, Enter completes instead of steering, and Escape closes the list instead of cancelling the run.

## Rules

| Rule | Choice |
| --- | --- |
| When the list shows | The input's whole text is `/` and letters, with no space or new line, and at least one command starts with it |
| Order | The order of the command table, which is alphabetical |
| Match | The command starts with the typed text, ignoring case |
| After a completion | The list stays closed until the text changes |
| Escape | Closes the list until the text changes |
| Footer | Shows the list's keys while it is open |
| Whole command | The list hides when the text is already a whole command, such as a typed `/model`, so one Enter sends it |

## Shape

The command table in `chat-commands.ts` gives each command a description and an Effect to run. `ChatClient.commands` exposes the names and descriptions. `command-suggestions.ts` holds the rule (`suggestions`, a pure function) and the list's state (`commandSuggestions`), which `App.tsx` creates. `Input.tsx` feeds it the editor's text on each change and lets it take Up, Down, Tab, Enter and Escape before the editor's own keys; `App.tsx` skips its Escape-cancels while the list is open, because global keys run before the editor's. `CommandList.tsx` draws the list in the picker's place, and `InputFooter.tsx` shows its keys. Completing sets the editor's text to the command.
