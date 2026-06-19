# Attention

Sends a terminal-driven attention notification when Tau is ready for input.

## Behavior

- Emits an attention notification on `agent_end`.
- Suppresses exactly one `agent_end` notification after `tau:posture.continuation_queued`, because a hidden continuation turn is about to start.
- Listens for shared event `tau:attention` so extensions can request the same notification.
- Uses the terminal or host OS notification path that best fits the current environment.

Other code can call:

```ts
emitTauEvent(pi, "tau:attention", { title: "Tau", body: "Ready for input" });
```

Both fields are optional. Defaults are `Tau` and `Ready for input`.

## Limits

- No configuration.
- No Windows-specific support.
- Exact notification behavior depends on terminal and OS support.
