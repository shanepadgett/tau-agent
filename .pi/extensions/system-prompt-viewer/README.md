# system-prompt-viewer

Local Tau development extension for inspecting the effective system prompt while debugging agent behavior.

Run `/system-prompt-viewer` to toggle automatic snapshots. When enabled, each agent turn adds a visible, collapsible system prompt snapshot to the chat and shows an active marker in the Tau footer.

Snapshots include the rendered system prompt and active tool schema summaries. They are display-only and are filtered out of model context.
