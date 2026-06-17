# Attention

Sends a terminal-driven attention notification when Tau is ready for input.

## Behavior

- Emits an attention notification on `agent_end`.
- Listens for shared event `tau:attention` so core modules and standalone extensions can request the same notification.
- Prefers CMUX first-class notifications, then Kitty OSC 99, then OSC 777.

Other code can call:

```ts
emitTauEvent(pi, "tau:attention", { title: "Tau", body: "Ready for input" });
```

Both fields are optional. Defaults are `Tau` and `Ready for input`.

## Limits

- No configuration.
- No Windows-specific support.
- CMUX uses `cmux notify` when CMUX is detected, with OSC 777 fallback if the command fails.
