# Roadmap

Only what is not done.

## Next, in order

1. Expired-login warning (today it shows only as a failed run's reason).
2. New front end: design the chat transcript as a gallery scenario, then swap it in ([gallery.md](gallery.md)).
3. Notifications: the remaining question ([notifications.md](notifications.md)).
4. Commands: `/compact`, `/settings`.
5. Extension SDK (`@shanepadgett/tau`), then rebuild on it the built-ins from `main`: md-lint, attention, auto-name, branch, cost-report, tool-approval, image-gen, worktree, run-summary, handoff, aside, manage-sessions ([sdk.md](sdk.md), [sdk-catalog.md](sdk-catalog.md)).
6. Packages, install, updates ([sdk-packages.md](sdk-packages.md)).

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
