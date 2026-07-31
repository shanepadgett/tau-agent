# Continuity

Keeps long-running agent work focused by letting the agent checkpoint durable working context while disposable conversation history is retired.

Checkpoint rows are hidden by default. Set `extensions.continuity.showToolRows` to `true` before `/reload` to watch checkpoint and newly injected-file rows while working. Existing injected-file rows keep their saved display state.

After changing this extension, run `/reload` before testing it.
