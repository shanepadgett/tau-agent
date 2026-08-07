# Bash Approval

Reviews every agent `bash` call with a quick-effort model before execution. The reviewer returns a validated decision and one concise paragraph that explains the command.

Trivially recognized read-only commands can run without a human prompt after a valid approval. With `autoApprove` enabled, every reviewer-approved command runs without another confirmation. Routine local development commands should be approved, including commands that modify project files or use shell composition. The reviewer asks for human approval only when it finds a concrete destructive, system, production, privileged, or security-sensitive effect.

When approval is required, Tau shows one paragraph that explains the effect and risk without repeating the command. If the reviewer fails or returns a malformed decision, Tau asks for direct human approval instead of running it automatically. Tau also sends an attention notification when the approval window opens.

Configure under `extensions.bashApproval`:

```json
{
  "extensions": {
    "bashApproval": {
      "enabled": true,
      "autoApprove": true
    }
  }
}
```
