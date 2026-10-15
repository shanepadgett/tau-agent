# Quickstart

1. Log in. Pick a provider, then paste an API key or follow the subscription prompt. `tau logout` removes a login.

   ```sh
   tau login
   ```

   Without a saved login, Tau reads the provider's environment variable, such as `OPENROUTER_API_KEY`.
2. Set a model, written `provider/model`, in `~/.tau/settings.json`. Tau has no default.

   ```json
   { "model": "anthropic/claude-sonnet-5-5" }
   ```
3. Run `tau` in the folder to work in.

Tau runs commands and changes files with your permissions and does not ask first.

## Models

| To change the model | Use |
| --- | --- |
| Always | `model` in settings |
| One run | `--model provider/model` |
| One chat | `/model` (Ctrl+F favorites a model) |
| Thinking level | Shift+Tab. Levels: `off`, `low`, `medium`, `high`, `xhigh`, `max`. A model without the level you pick uses the nearest it offers. |

A resumed session continues with the model of its latest reply. Tau hides models that cannot call tools; to show one that can, set `providers.<provider>.models.<model>.supports.tools` to `true`.
