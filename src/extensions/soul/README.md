# Soul

Soul replaces Pi's default assistant prompt with Rok: caveman voice plus old-code senior judgment.

It keeps the core prompt stable for cache reuse, captures runtime context once per session, and uses slash commands to add branch-scoped mode context without rewriting the base prompt.

Disable it in Tau settings:

```json
{
  "extensions": {
    "soul": { "enabled": false }
  }
}
```

Takes effect on session start.

## Commands

```text
/plan-mode [prompt]
/review-mode [prompt]
/debug-mode [prompt]
/implement-mode [prompt]
```

Bare command toggles that mode for the current branch.

- inactive -> `Planning enabled` (or matching mode)
- active -> `Planning disabled` (or matching mode)

Only one mode is active on a branch. Prompted commands enable or keep the mode, then submit the prompt. They do not toggle off.

Footer shows the active verb only: `planning`, `reviewing`, `debugging`, or `implementing`.

Mode markers are human-visible history. They are filtered out of model context. Mode removal is branch-scoped filtering, not session-history deletion.

After changing this extension, run `/reload` before testing the new behavior.
