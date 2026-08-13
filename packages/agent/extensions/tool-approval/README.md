# Tool Approval

Reviews agent `bash` and `script_runner` requests with a quick-effort model before execution. The reviewer returns a validated decision and one concise paragraph that explains the request.

Trivially recognized read-only bash commands can run without a human prompt after a valid approval. With `autoApprove` enabled, every reviewer-approved request runs without another confirmation. Routine local development work should be approved, including requests that modify project files or run scripts. The reviewer asks for human approval only when it finds a concrete destructive, system, production, privileged, or security-sensitive effect.

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
