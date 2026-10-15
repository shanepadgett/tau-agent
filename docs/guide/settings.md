# Settings

Global: `~/.tau/settings.json`. Project: `.tau/settings.json` at the Git repository root (the launch folder outside Git). Both allow comments, are read when Tau starts, and a project value overrides the global one field by field (nested objects merge). A wrong value stops Tau and names it. `--model` overrides `model`. A project file can change provider connections: review it in unfamiliar repositories.

| Setting | Default | Does |
| --- | --- | --- |
| `model` | none | `provider/model` for every run |
| `maxTurns` | no limit | Ends a run after this many turns |
| `timeouts.run` | 600 | Seconds for one `run` call. The model can set its own; this limit always wins. |
| `timeouts.shell` | 120 | Seconds for one shell command |
| `agentsFiles` | `true` | `false`: read no `AGENTS.md`, yours or the project's |
| `autoRestart` | `true` | `false`: when run from source, restart into changed code only on `/restart` |
| `notifications.enabled` | `true` | `false`: no sound and no banners |
| `notifications.sound` | `true` | `false`: no Tau sound; banners stay |
| `logLevel` | `Warn` | Least severe level kept in `~/.tau/logs`: `Error`, `Warn`, `Info`, `Debug` |
| `commit.push` | `"ask"` | After `/commit`: `"ask"` (No chosen first), `true` pushes, `false` never |
| `commit.avoidBreakingChanges` | `false` | `true`: never mark a commit as breaking |
| `compaction.method` | `"notes"` | `"off"` sends the whole history |
| `compaction.budgetTokens` | 200000 | Context budget, capped by the model's window less 16000. The model is nudged at 50%, 75%, 100%; at 100% every tool but `checkpoint` fails. |
| `compaction.notesStartTokens` | 50000 | Past this size, a small model writes background notes |
| `providers.<id>.smallModel` | per provider | Cheap model for notes, memory and `/commit` |
| `providers.<id>.models.<m>` | | Model entry: `contextTokens`, `outputTokens`, `supports.tools` |

## Providers

A `providers` entry named like a built-in provider changes only its models and small model. Any other name adds a provider and needs `protocol` (`anthropic`, `openaiResponses` or `openaiChat`) and `apiUrl`. It sends no key unless `apiKeyEnv` names the variable holding one.

```jsonc
{
  "providers": {
    "local": {
      "protocol": "openaiChat",
      "apiUrl": "http://localhost:8080/v1",
      "apiKeyEnv": "LOCAL_API_KEY",
      "models": { "my-model": { "contextTokens": 128000, "outputTokens": 8000 } }
    }
  }
}
```

Default small models: `claude-haiku-5-5` (Anthropic), `gpt-6-luna` (OpenAI, ChatGPT, Codex), DeepSeek V4.1 Flash (OpenCode Go, OpenRouter). If a provider lacks its small model, the session model is used.

## Other

- `web.search` uses the session provider's own search; OpenRouter, OpenCode Go and custom providers use Exa. Set `EXA_API_KEY` before starting Tau for those, or Exa's free tier often refuses searches.
- Notifications play one sound, and a banner when the terminal is unfocused, per finished turn or question. Banners need terminal support. Cancelled runs and print mode are silent. Sound: “Intuition” by NotificationSounds.com, CC BY 4.0.
