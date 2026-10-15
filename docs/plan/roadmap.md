# Roadmap

What is left to do. Built work is in the code and in `docs/guide/`. A file named here holds the thinking for that item.

## Verify what is built

Use Tau daily and report what breaks. Not yet tried in a real terminal: emoji alignment of file tags (Ghostty, iTerm, tmux), pasted images, the sidebar's docked slide on a long transcript, the bundled notification sound in the compiled binary.

## Next, in order

1. Expired-login warning (today it shows only as a failed run's reason).
2. Stash a draft with Ctrl+S. Decisions agreed; footer mockup awaits approval ([stash.md](stash.md)).
3. New front end designed in a gallery, then swapped in ([gallery.md](gallery.md)).
4. Notifications: remaining question and live terminal check ([notifications.md](notifications.md)).
5. Commands: `/compact`, `/settings`, login.
6. Extension SDK (`@shanepadgett/tau`), then rebuild the built-ins from `main` on it: md-lint, attention, auto-name, branch, cost-report, stash, tool-approval, web, image-gen, worktree, run-summary, handoff, reference, aside, manage-sessions ([sdk.md](sdk.md), [sdk-catalog.md](sdk-catalog.md)).
7. Packages, install, updates ([sdk-packages.md](sdk-packages.md)).

## Agreed, not scheduled

Described in [features.md](features.md).

- Prompt classifier: one cheap call per prompt picks the route and suggests functions and skills.
- Prompt files: reusable prompts with `$1`, `$ARGUMENTS` and code blocks.
- Deferred functions: extension functions hidden until the model searches for them.
- Branching and reset in the chat.
- Custom messages that may start a turn.
- Simulation mode: the real chat on scripted replies ([simulation.md](simulation.md)).
- Cache miss warnings.

## Ideas

Multi-repository sessions, bundled ripgrep, a 1-hour cache setting, asking to compact when the cache is cold, a live inspector (`tau observe`), a system prompt view, HTML export, a question tracker. Smaller later decisions: [deferred.md](deferred.md).
