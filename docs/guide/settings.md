# Change Tau's settings

`~/.tau/settings.json` sets the model, run limits, extra model providers and whether Tau reads `AGENTS.md` files. Without the file, Tau uses its defaults.

1. Create or open `~/.tau/settings.json`. Comments are allowed.
2. Add the settings you need:

   ```jsonc
   {
     // The model for every run, as route/model.
     "model": "anthropic/claude-sonnet-5-5",
     // End a run after this many turns. Without it, there is no limit.
     "maxTurns": 50,
     // Default time limits in seconds. The model can set its own for one call.
     "timeouts": { "run": 600, "shell": 120 },
     // false: Tau reads no AGENTS.md file, yours or the project's.
     "agentsFiles": true,
     "routes": {
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
- An entry under `routes` with the name of a built-in route changes only its models. Any other name adds a route, which needs `protocol` (`anthropic`, `openaiResponses` or `openaiChat`) and `apiUrl`.
- A route you add sends no key unless `apiKeyEnv` names the environment variable that holds it.
- `"agentsFiles": false` turns off every `AGENTS.md` file. Instruction files and skills still load. See [Write instruction files](write-instruction-files.md).

## Limits

- A wrong value stops Tau with a message that names the file and the setting.
- Tau reads the file only when it starts.
