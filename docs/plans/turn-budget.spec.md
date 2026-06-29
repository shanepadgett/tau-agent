When a Tau session starts, the turn-budget extension shall reset its tool-call count to zero and its soft cap to the configured tool-call limit.

When the turn-budget extension is enabled and a tool call starts, the turn-budget extension shall increment the session tool-call count by one.

When the turn-budget extension is disabled and a tool call starts, the turn-budget extension shall not increment the session tool-call count.

When the session tool-call count reaches a configured nudge interval, the turn-budget extension shall add a hidden context hint to the next outbound model context.

When the turn-budget extension adds a hidden context hint before the soft cap is reached, the hint shall state the current tool-call count, the current soft cap, and a short instruction to batch tools when possible.

When the session tool-call count reaches or exceeds the current soft cap, the turn-budget extension shall extend the soft cap by 10 tool calls.

When the turn-budget extension extends the soft cap, the next hidden context hint shall state the current tool-call count, the previous soft cap, the new soft cap, and a short instruction to batch tools when possible.

When multiple tool calls execute in one assistant tool batch, the turn-budget extension shall count each tool call separately.

When multiple tool calls execute in one assistant tool batch, the model shall receive at most one turn-budget hint on the next outbound model context.

When no new nudge boundary or soft-cap extension has occurred since the last turn-budget hint, the turn-budget extension shall not add another turn-budget hint.

When turn-budget hints are added to outbound model context, the turn-budget extension shall not block tools, stop the agent, shut down the session, or trigger compaction.

When the user runs `/turn-count-visibility`, the turn-budget extension shall toggle session-local visible turn-budget markers for future turn-budget hints.

When visible turn-budget markers are enabled and a turn-budget hint is created, the turn-budget extension shall show a visible marker in the conversation.

When visible turn-budget markers are disabled and a turn-budget hint is created, the turn-budget extension shall not show a visible marker in the conversation.

When visible turn-budget markers are toggled, the turn-budget extension shall not change whether hidden context hints are sent to the model.

When a visible turn-budget marker is shown before soft-cap extension, the marker shall show `Turn Budget:` and the current count as `<used>/<soft-cap>`.

When a visible turn-budget marker is shown after soft-cap extension, the marker shall show `Turn Budget:`, the current count as `<used>/<new-soft-cap>`, and `Soft cap extended.`

When the user runs `/tool-preview turn-budget`, Tau shall show a preview of the turn-budget agent payload and visible marker states.

When Tau shows the turn-budget preview, the preview shall include normal boundary, soft-cap reached, and soft-cap exceeded samples.
