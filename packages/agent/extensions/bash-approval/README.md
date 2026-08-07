# Bash Approval

Reviews every agent `bash` call with a quick-effort model before execution. The reviewer submits a validated decision that breaks the command into steps and reports risks and unknowns.

Trivially recognized read-only commands can run without a human prompt after a valid approval. With `autoApprove` enabled, recognized direct commands with plain arguments can also run when the reviewer approves them. Quoted, composed, piped, redirected, opaque, or unrecognized shell input always requires human confirmation. Otherwise, Tau shows the review and asks for confirmation.

If the reviewer fails or returns a malformed decision, Tau shows the complete command and asks for direct human approval instead of running it automatically. Tau also sends an attention notification when the approval window opens.

Configure under `extensions.bashApproval`:

```json
{
  "extensions": {
    "bashApproval": {
      "enabled": true,
      "autoApprove": false
    }
  }
}
```
