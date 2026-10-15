# Change Tau's settings

`~/.tau/settings.json` sets the model, run limits, extra model providers and whether Tau reads `AGENTS.md` files. Without the file, Tau uses its defaults.

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

## What happens

- `timeouts.run` limits one `run` call (default 600 seconds). `timeouts.shell` limits one shell command (default 120 seconds). The run limit always wins.
- An entry under `providers` with the name of a built-in provider changes only its models and small model. Any other name adds a provider, which needs `protocol` (`anthropic`, `openaiResponses` or `openaiChat`) and `apiUrl`.
- `providers.<id>.smallModel` picks the cheap model for background notes, memory and `/commit` on that provider. Each built-in provider has one already. See [Use checkpoints](checkpoints.md).
- `commit.push` and `commit.avoidBreakingChanges` change `/commit`. See [Commit your changes with `/commit`](commit.md).
- A provider you add sends no key unless `apiKeyEnv` names the environment variable that holds it.
- `"agentsFiles": false` turns off every `AGENTS.md` file. Instruction files and skills still load. See [Write instruction files](write-instruction-files.md).
- `"autoRestart": false` makes `/restart` the only way to restart the chat into code that changed. It matters only when you run Tau from its source. See [Chat with Tau in the terminal](chat.md).
- `logLevel` defaults to `Warn`. `Info` or `Debug` keep more in the log files. See "Logs" in [Chat with Tau in the terminal](chat.md).
- `compaction.method` defaults to `notes`. Set it to `off` to send the whole history. Existing checkpoints and raw entries remain stored.
- `compaction.budgetTokens` defaults to 200000, capped by the model's window less 16000 tokens and its long-context price threshold. Hidden nudges tell the model when it reaches 50%, 75% and 100% of this budget.
- `compaction.notesStartTokens` defaults to 50000. Past this size, background notes cover complete message ranges of at least 16000 estimated tokens. See [Use checkpoints](checkpoints.md).

## Limits

- A wrong value stops Tau with a message that names the file and the setting.
- Tau reads the file only when it starts.
