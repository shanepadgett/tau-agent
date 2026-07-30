# aside Extension

Ask the current model a one-off side question without adding it or its answer to the current conversation.

Run `/aside <question>`, then choose whether to include the current conversation branch or ask with no context. The request uses the current model without tools and runs in the background. A status widget remains above the editor while the model is thinking, then the answer opens in an overlay.

Run `/aside` to open the latest answer. Run `/aside clear` to cancel a running aside and clear its in-memory result. Aside results also clear when the session changes or Tau reloads.
