# Choose a model

Tau has no default model, because the right one depends on which providers you have logged in to.

1. Log in to a provider (see [log-in.md](log-in.md)).
2. Add the model to `~/.tau/settings.json`, written as `route/model`:

   ```json
   { "model": "anthropic/claude-sonnet-5-5" }
   ```

3. To use another model for one run, pass `--model`:

   ```sh
   tau -p --model openrouter/anthropic/claude-haiku-5.5 "Summarize README.md"
   ```

## What happens

- The route is the text before the first slash. The rest is the model's name on that route, and it can contain slashes.
- `--model` wins over the settings file.

## Limits

- Tau hides models that cannot call tools, because it cannot work without them. If a hidden model can call tools, set `routes.<route>.models.<model>.supports.tools` to `true` in the settings file (see [settings.md](settings.md)).
