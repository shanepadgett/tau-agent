# Tool Approval

Reviews agent `bash` and `script_runner` requests before they run.

Common read-only bash commands skip review and run immediately. Other bash and every `script_runner` request go to a quick-effort model. The reviewer returns a validated decision and one concise paragraph that explains the request.

With `autoApprove` enabled, reviewer-approved requests run without another confirmation. Tau shows a user-only marker after those auto-approvals. Common read-only bash that skips review does not get a marker. Routine local development work should be approved, including requests that modify project files or run scripts. The reviewer asks for human approval only when it finds a concrete destructive, system, production, privileged, or security-sensitive effect.

When approval is required, Tau shows one paragraph that explains the effect and risk without repeating the request. If the reviewer fails or returns a malformed decision, Tau asks for direct human approval instead of running it automatically. Tau also sends an attention notification when the approval window opens.

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
