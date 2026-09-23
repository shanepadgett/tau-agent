# Tool Approval

Reviews agent `bash` and `script_runner` requests before they run.

Common read-only bash commands skip review and run immediately. Other bash and every `script_runner` request go to a separate reviewer. Tau uses the reviewer model for the current provider, then the current chat model if that reviewer is unavailable or fails. If a reviewer model is unavailable or fails, Tau notifies and tries the next one. The reviewer returns a validated decision and one concise paragraph that explains the request.

With `autoApprove` enabled, reviewer-approved requests run without another confirmation. Tau shows a user-only marker with the reviewer model after those auto-approvals. Common read-only bash that skips review does not get a marker. Routine local development work should be approved, including requests that modify project files or run scripts. The reviewer asks for human approval only when it finds a concrete destructive, system, production, privileged, or security-sensitive effect.

When approval is required, Tau shows one paragraph that explains the effect and risk without repeating the request. If the reviewer fails or returns a malformed decision, Tau asks for direct human approval instead of running it automatically. Tau also sends an attention notification when the approval window opens.

In the terminal approval panel, move between Approve and Reject, press `n` to add a note to the highlighted choice, then press Enter to choose. Enter saves an edited note before choosing; Escape cancels note editing or blocks the request from the choice list. A rejection note tells the agent why the request was blocked. An approval note reaches the agent with the tool result; it does not change the request being approved. To ask for a different request, reject it with a note. Long notes are truncated. RPC clients use the standard confirmation dialog without notes.

Configure under `extensions.toolApproval`:

```json
{
  "extensions": {
    "toolApproval": {
      "enabled": true,
      "autoApprove": true
    }
  }
}
```
