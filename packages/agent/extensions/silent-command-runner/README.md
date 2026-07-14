# Silent Command Runner

Runs configured commands after Tau changes matching files. Tau tells the agent which configured commands are automatic so it does not run them manually.

Use it for quiet post-edit checks such as `mise run check`. It stays out of the transcript when commands pass. When a command fails, it posts one Tau message with raw stdout/stderr tail output and starts the agent on the failure.

Configure it in Tau settings under `extensions.silentCommandRunner`:

```json
{
  "extensions": {
    "silentCommandRunner": {
      "commands": [
        {
          "name": "check",
          "command": "mise run check",
          "includeGlobs": ["packages/**/*.ts", ".pi/extensions/**/*.ts"]
        }
      ]
    }
  }
}
```

Passes are notifications only. Failures are shown in chat and sent to the agent.
