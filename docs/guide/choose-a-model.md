# Choose a model

Tau has no default model, because the right one depends on which providers you have logged in to.

1. Log in to a provider (see [log-in.md](log-in.md)).
2. Add the model to `~/.tau/settings.json`, written as `provider/model`:

   ```json
   { "model": "anthropic/claude-sonnet-5-5" }
   ```

3. To use another model for one run, pass `--model`:

   ```sh
   tau -p --model openrouter/anthropic/claude-haiku-5.5 "Summarize README.md"
   ```

4. To change the model in the chat, type `/model` and press Enter. Type to filter the list, then press Enter on the model you want. Only that chat changes; new chats still start with the model in your settings.
5. To keep a model at the top of `/model`, move to it and press Ctrl+F. Press Ctrl+F on it again to move it back.
6. To change how hard the model thinks, press Shift+Tab in the chat between runs. Each press steps up one level, and the level at the top steps back to the lowest.

## What happens

- The provider is the text before the first slash. The rest is the model's name on that provider, and it can contain slashes.
- `--model` wins over the settings file.
- A resumed session goes on with the model of its latest reply, whatever `--model` or the settings say.
- `/model` lists the models of every provider you have logged in to, one line each: the model's name, then its provider in parentheses. The filter matches the name and the `provider/model` text.
- Models you pressed Ctrl+F on list first, above a line. Each part sorts by provider, then by maker (such as `anthropic` in `openrouter/anthropic/claude-haiku-5.5`), then by model.
- After Ctrl+F the cursor stays in its place in the list, so it can be on another model.
- Tau saves these models in `~/.tau/favorites.json`, as a list of `provider/model` texts, so every chat shows them first. A saved model that is not available now, such as one on a provider you logged out of, does not show and stays saved.
- The thinking levels are `off`, `low`, `medium`, `high`, `xhigh` and `max`. Each model offers some of them, as its entry in the models.dev catalog says. A new chat and `tau -p` start at `medium`.
- When the model lacks the chosen level, as after `/model`, it runs at the nearest level it offers: the next one up, or else the next one down. The footer shows that level. A model that offers no levels shows none.
- Each reply saves the level with its model, so a resumed session goes on at that level.

## Limits

- Tau hides models that cannot call tools, because it cannot work without them. If a hidden model can call tools, set `providers.<provider>.models.<model>.supports.tools` to `true` in the settings file (see [settings.md](settings.md)).
