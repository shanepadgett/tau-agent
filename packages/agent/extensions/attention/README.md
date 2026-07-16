# Attention

Sends a terminal-driven attention notification when Tau is ready for input, finishes compacting a session, or summarizes an abandoned branch during tree navigation.

## Behavior

- Emits an attention notification on `agent_end`.
- Emits an attention notification on `session_compact`.
- Emits an attention notification on `session_tree` when it includes a branch summary.
- Listens for shared event `tau:agent.blocked` when Tau is waiting on user input.
- Uses the terminal or host OS notification path that best fits the current environment.

Other code can call:

```ts
emitAgentBlocked(pi, { source: "my-extension", body: "Waiting for your input" });
```

`title`, `body`, and `source` are optional. Notification defaults are `Tau` and `Ready for input`.

## Limits

- No configuration.
- No Windows-specific support.
- Exact notification behavior depends on terminal and OS support.
