# Change Tau's settings

Set global defaults in `~/.tau/settings.json` and override them for one project in `.tau/settings.json`.

1. Create or open `~/.tau/settings.json`. Comments are allowed.
2. Add the settings you need:

   ```jsonc
   {
     // The model for every run, as provider/model.
     "model": "anthropic/claude-sonnet-5-5",
     // End a run after this many turns. Without it, there is no limit.
     "maxTurns": 50,
     // Default time limits in seconds. The model can set its own for one call.
     "timeouts": { "run": 600, "shell": 120 },
     // false: Tau reads no AGENTS.md file, yours or the project's.
     "agentsFiles": true,
     // false: when run from source, Tau restarts into changed code only on /restart.
     "autoRestart": true,
     // Both default to true. enabled: false disables sound and banners.
     "notifications": { "enabled": true, "sound": true },
     // The least severe level that ~/.tau/logs keeps: Error, Warn, Info or Debug.
     "logLevel": "Warn",
     "compaction": {
       "method": "notes",
       "budgetTokens": 200000,
       "notesStartTokens": 50000
     },
     // What /commit does after it commits: "ask", true or false.
     "commit": { "push": "ask", "avoidBreakingChanges": false },
     "providers": {
       // The cheap model for background notes, memory and /commit on this provider.
       "anthropic": { "smallModel": "claude-haiku-5-5" },
       // A server of your own that speaks the Chat Completions API.
       "local": {
         "protocol": "openaiChat",
         "apiUrl": "http://localhost:8080/v1",
         "apiKeyEnv": "LOCAL_API_KEY",
         "models": { "my-model": { "contextTokens": 128000, "outputTokens": 8000 } }
       }
     }
   }
   ```

3. Run Tau again. Tau reads the file when it starts.

## Override settings for one project

1. Create `.tau/settings.json` at the Git repository root. Outside Git, create it in the directory where you launch Tau.
2. Add the fields to override. To suppress breaking-change labels in this repository’s commit messages:

   ```json
   { "commit": { "avoidBreakingChanges": true } }
   ```

3. Restart Tau to read the settings.

The project file supports the same settings and comments as the global file. Project values override global values field by field; nested objects merge. This example inherits your global `commit.push` preference. Missing fields use global values, then built-in defaults.

Tau finds the repository-root file even when launched from a subdirectory. Each worktree uses its own file. You can check the file into Git to share it with your team or ignore it for personal use. There is no separate personal-project settings file.

## What happens

- `timeouts.run` limits one `run` call (default 600 seconds). `timeouts.shell` limits one shell command (default 120 seconds). The run limit always wins.
- An entry under `providers` with the name of a built-in provider changes only its models and small model. Any other name adds a provider, which needs `protocol` (`anthropic`, `openaiResponses` or `openaiChat`) and `apiUrl`.
- `providers.<id>.smallModel` picks the cheap model for background notes, memory and `/commit` on that provider. Each built-in provider has one already. See [Use checkpoints](checkpoints.md).
- `commit.push` and `commit.avoidBreakingChanges` change `/commit`. See [Commit your changes with `/commit`](commit.md).
- A provider you add sends no key unless `apiKeyEnv` names the environment variable that holds it.
- `"agentsFiles": false` turns off every `AGENTS.md` file. Instruction files and skills still load. See [Write instruction files](write-instruction-files.md).
- `"autoRestart": false` makes `/restart` the only way to restart the chat into code that changed. It matters only when you run Tau from its source. See [Chat with Tau in the terminal](chat.md).
- `notifications.enabled` disables both sound and banners when false. `notifications.sound` disables only Tau’s custom sound. See [Control notification sounds](notifications.md).
- `logLevel` defaults to `Warn`. `Info` or `Debug` keep more in the log files. See "Logs" in [Chat with Tau in the terminal](chat.md).
- `compaction.method` defaults to `notes`. Set it to `off` to send the whole history. Existing checkpoints and raw entries remain stored.
- `compaction.budgetTokens` defaults to 200000, capped by the model's window less 16000 tokens and its long-context price threshold. Hidden nudges tell the model when it reaches 50%, 75% and 100% of this budget.
- `compaction.notesStartTokens` defaults to 50000. Past this size, background notes cover complete message ranges of at least 16000 estimated tokens. See [Use checkpoints](checkpoints.md).

## Limits

- A wrong value in either file stops Tau with a message that names the file and the setting.
- Project settings can change provider connections. Review `.tau/settings.json` before running Tau in an unfamiliar repository.
- An explicit `--model` choice overrides the model in settings.
- Tau reads the file only when it starts.
