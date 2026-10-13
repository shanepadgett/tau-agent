# Live models

**Question:** do Tau's tools and agent loop work on every model of the live model matrix (the table in `docs/plan/tooling.md`)?

**Run:** `bun spikes/live-models/check.ts [route/model ...]`. With no arguments it runs the whole matrix, one model after another. It builds `dist/tau` with `bun build --compile`, makes a fresh git repository for each model in `work/`, and sends four prompts to the binary in one session, with the logins saved in `~/.tau`. The sessions are saved in `~/.tau/sessions.db`, and the script reads them back from there to grade each prompt. Results go to `results.json` and a table on stdout.

| Prompt | Graded from | Pass means |
| --- | --- | --- |
| Print `VERSION` with `sh`, read `src/app.js` | answer, tool results | a `run` call succeeds; the answer names the version and the function |
| (same answer) | answer | it ends with the line `src/AGENTS.md` asks for |
| Rename a function and change a word in `src/app.js` | the file | every change is in the file |
| Run a given program that reads the wrong file name, then fix it | tool results, answer | the first script fails, a later one prints the port |
| Write release notes | tool calls, `RELEASE.md` | the script calls the `release-notes` skill; the file follows the skill |

Also reported, not graded: whether the model fixed the script with `scriptId` and edits, and the cache read tokens of every model call after the first. Every prompt after the first is a follow-up, so a provider that refuses the reasoning Tau sends back fails that prompt.

## Results

First run, 13 October 2026, against the slice 4c build:

| Model | Tools | AGENTS.md | Edits | Script fix | Fixed with edits | Skill | Cache read |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `chatgpt/gpt-6-luna` | pass | pass | pass | pass | no | pass | 19968 |
| `chatgpt/gpt-6.1-sol` | pass | pass | pass | FAIL | no | pass | 25472 |
| `codex/gpt-6-luna` | pass | pass | pass | FAIL | yes | pass | 23552 |
| `codex/gpt-6.1-sol` | pass | pass | pass | FAIL | no | pass | 23168 |
| `anthropic/claude-haiku-5-5` | pass | pass | pass | pass | yes | pass | 59305 |
| `anthropic/claude-sonnet-5-5` | pass | pass | pass | pass | no | pass | 50093 |
| `anthropic/claude-opus-5-5` | pass | pass | pass | pass | no | pass | 45641 |
| `opencode-go/deepseek-v4.1-flash` | pass | pass | pass | pass | no | pass | 37632 |
| `opencode-go/kimi-k3` | pass | pass | pass | pass | yes | pass | 37440 |
| `opencode-go/muse-spark-1.3-contributor` | pass | pass | pass | pass | no | pass | 45674 |
| `opencode-go/minimax-m3` | pass | pass | pass | pass | no | pass | 40517 |
| `openrouter/google/gemini-3.8-flash` | pass | pass | pass | pass | yes | FAIL | 4109 |

What failed:

- **OpenAI models, `run` parameters that do not decode end the whole run.** Effect's OpenAI package sends tools in strict mode, so every optional `run` field becomes a required field that may be `null`. Valid calls have their `null`s removed. A call that fails Tau's schema (for example, an empty `edits` list, or a timeout out of range) is passed on with its `null`s, and Effect's decode of the model reply then fails with `Invalid output: Expected string | undefined at [1]["params"]["code"]`. The run ends with an error, and the model never sees what was wrong. `chatgpt/gpt-6.1-sol` and `codex/gpt-6-luna` hit this.
- **OpenAI models fill in fields they should leave empty.** Because strict mode makes every field required, `codex/gpt-6-luna` sent `code` together with a `scriptId` on new programs, which Tau refuses ("Send code, or scriptId and edits, not both.").
- **`codex/gpt-6.1-sol`: `OpenAiClient.createResponseStream: Invalid output: Failed to decode response`**, after a script with a typo failed to parse. The raw event was not saved, so the cause is unknown; it may be the same `null` problem in another place.
- **Gemini on OpenRouter ended a turn with an empty reply.** After the skill's text came back, the next model call returned no parts, and Tau treated that as the final answer, so `RELEASE.md` was never written. Gemini also read little from the prompt cache (4109 tokens over the whole session).

Every Anthropic and OpenCode Go model passed every prompt. Three models of twelve fixed the failed script with `scriptId` and edits; the rest sent the whole program again.

Second run, the same day, after three fixes: `run` gives Effect only a JSON schema and Tau checks the parameters itself, strict mode is off for `run`, and an empty reply is tried again. Every model passed every prompt. Seven of twelve fixed the failed script with `scriptId` and edits, and no call sent `code` with a `scriptId`.

| Model | Fixed with edits | Cache read |
| --- | --- | --- |
| `chatgpt/gpt-6-luna` | yes | 21504 |
| `chatgpt/gpt-6.1-sol` | yes | 24832 |
| `codex/gpt-6-luna` | no | 21504 |
| `codex/gpt-6.1-sol` | yes | 27776 |
| `anthropic/claude-haiku-5-5` | no | 51431 |
| `anthropic/claude-sonnet-5-5` | no | 43977 |
| `anthropic/claude-opus-5-5` | yes | 49539 |
| `opencode-go/deepseek-v4.1-flash` | no | 32384 |
| `opencode-go/kimi-k3` | yes | 26624 |
| `opencode-go/muse-spark-1.3-contributor` | no | 52699 |
| `opencode-go/minimax-m3` | yes | 35022 |
| `openrouter/google/gemini-3.8-flash` | yes | 20234 |

In that run, DeepSeek's first attempt was stopped by hand. OpenCode Go sent some of its calls to a backend that gives tool call IDs starting `chatcmpl-tool-`, and all 229 calls from that backend came back with empty parameters. The model kept sending `run` with no parameters, and Tau has no limit that stops a model that repeats one failing call. On a rerun, every call went to DeepSeek's own backend (`call_` IDs) and all prompts passed. The first run never reached that backend, so it is not known whether turning strict mode off makes OpenCode Go use it.

## Limits

- Two runs per model; a model that passes can still fail sometimes.
- Retries are not saved in the session, so the results do not show whether an empty reply was tried again.
- macOS arm64 only, so far.
