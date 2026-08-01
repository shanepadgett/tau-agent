# Continuity

Keeps long-running agent work focused by letting the agent checkpoint durable working context while disposable conversation history is retired.

Checkpoint rows are hidden by default. Set `extensions.continuity.showToolRows` to `true` before `/reload` to watch checkpoint and newly injected-file rows while working. Existing injected-file rows keep their saved display state.

Continuity nudges the agent at 50% and 75% of `extensions.continuity.checkpointTokenLimit`, which defaults to 150,000 context tokens. At the limit, it blocks non-checkpoint tools until the agent checkpoints.

After changing this extension, run `/reload` before testing it.
