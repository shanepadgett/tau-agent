# Slice 4b: instructions and errors

Status: agreed 2026-10-13. Build step 4's slices are in [agent-loop.md](agent-loop.md). File paths predate the module layout in [architecture.md](../architecture.md#package-layout); when building, put each file in that layout (for example `src/core/internal/loop/` for operations, `src/core/Client.ts` for events).

After 4b, the model knows the date, where it runs and what the project's `AGENTS.md` files say, and it learns about changes to them without the cached part of the request changing. A rate limit or a dropped connection no longer ends a run: Tau waits and tries again. When a ChatGPT or Claude plan runs out, Tau says so, says when it resets and links to the usage page, and does not retry.

## What exists

A step (`src/core/step.ts`) tries the operations in `src/core/operations.ts` in order, and the first that applies saves entries. The model call sends `Soul` (`BASE_PROMPT`, `src/core/base-prompt.ts`) as the system prompt and `contextView(entries)` (`src/session/context-view.ts`) as the chat. Any model error ends the run as `failed`, and print mode shows the error's own text.

```mermaid
flowchart LR
  A[interrupt started calls] --> B[run tool calls] --> C[stop at turn limit] --> D[call the model]
```

## Shape after 4b

```mermaid
flowchart LR
  A[interrupt started calls] --> B[run tool calls] --> C[stop at turn limit] --> I[update instructions] --> D[call the model, with retries]
```

Two changes to the step and one to the `ai` layer. No new layer.

| Piece | Change | Where |
| --- | --- | --- |
| Instruction sources | New: date, environment, `AGENTS.md` files | `src/core/instructions.ts`, `src/core/sources.ts` |
| `instructions` entry | New entry type | `src/session/entry.ts` |
| Context view | Puts the first `instructions` entry in the system prompt, later ones in the chat as notes | `src/session/context-view.ts` |
| Model call | Retries, plan limits, output limit | `src/core/operations.ts` |
| Plan usage limits | Recognized in `ai`, turned into Effect's `QuotaExhaustedError`, which is never retried | `src/ai/plan-limits.ts` |
| Claude cache marks | The system prompt and the last message carry a cache mark | `src/session/context-view.ts` |
| Failure text | Names the plan, the reset time and the usage page | `src/core/failure-text.ts`, used by `runEnded` in `agent.ts` |

## Instructions as value deltas

Agreed earlier ([architecture.md](../architecture.md#core-ideas)): each source has a key and a current value. Before each model call Tau reads every source and saves one `instructions` entry with the values that changed. Systems studied: OpenCode (`core/src/instructions/`, `builtins.ts`, `config/plugin/instruction.ts`), Codex (`AGENTS.md` from the git root down), Pi (`AGENTS.md` up to `/`).

**Agreed sources,** most shared first, so the cached prefix also repeats across sessions:

| Source key | Value | First rendering (system prompt) | Change rendering (note in the chat) |
| --- | --- | --- | --- |
| `agents:<path>`, one per file | `~/.agents/AGENTS.md` (the shared place for all agents), `~/.tau/AGENTS.md`, then each `AGENTS.md` from the repository root down to the session directory | `Instructions from <path>:` and the text | `<path> changed. It now says:` and the text, or `<path> was removed.` |
| `tau/date` | Today's date in local time, from `Clock` | `Today's date is Tuesday, 13 October 2026.` | `Today's date is now …` |
| `tau/environment` | Session directory, git repository or not, OS and CPU, "commands run in `sh`" | An `<environment>` block | `The environment is now:` and the block |
| `tau/files` | The session directory two levels deep, files and folders, without what `.gitignore` excludes, at most 200 lines | A `<files>` block | `Files added:` and `Files removed:` lists only |

Outside a git repository, "repository root down" is the session directory only. Tau reads `AGENTS.md` only, never `CLAUDE.md`. `tau/files` gets its list from `git ls-files` through `proc` in a repository, and from the file system elsewhere, skipping dot folders.

**`AGENTS.md` in subdirectories** (after OpenCode's `session/instructions.ts`). When a script's `read`, `write` or `replace` touches a file below the session directory, each `AGENTS.md` between the session directory and that file that is not yet loaded is added as a note after the tool result. It is never in the system prompt, because the agent found it by its own work. From then on it is a source like the others, so a later edit adds a change note. Files a script reaches only through `sh` (such as `cat`) do not count: Tau cannot see them.

To keep the step re-entrant, the tool result saves the paths its file functions touched (`files`), and the update reads them from the entries, not from memory.

```ts
// src/core/instructions.ts
type InstructionSource = {
  readonly key: string;
  readonly read: Effect.Effect<Option.Option<string>>; // none: the source has no value
  readonly first: (value: string) => string;
  readonly changed: (value: string) => string;
  readonly removed: string;
};

// src/session/entry.ts: the text is saved as rendered, so a later wording change cannot alter old requests
InstructionsEntry = { type: "instructions"; placement: "system" | "note"; values: Record<string, string | null>; text: string }
ToolResultEntry  += { files: readonly string[] }  // paths the script's file functions touched
```

```text
update instructions (operation), when the model answers next:
  saved = fold the values of every instructions entry
  sources = built-in sources + an agents source for each subdirectory AGENTS.md already saved
                              + for each file in tool results since the last model call, the AGENTS.md files above it not saved yet
  current = read each source; a source that fails keeps its saved value and logs a warning
  if no instructions entry yet: save { placement: system, values: current, text: first renderings }
  else if current differs from saved: save { placement: note, values: changed keys, text: change renderings }
  else pass

context view:
  system prompt = Soul + text of the newest "system" entry   (compaction writes a new one in step 5)
  each "note" entry = a user message at its place in the chat
```

The system prompt is then fixed for the whole session until compaction, so the provider's cache keeps working when `AGENTS.md`, the date or the files change.

## Claude cache marks

Claude caches only up to the parts a request marks; OpenAI caches without marks. The context view marks the end of the system prompt and the last message with `cacheControl: { type: "ephemeral" }`, under both the `anthropic` and `openrouter` option keys that Effect's providers read (`@effect/ai-anthropic` `getCacheControl`; `@effect/ai-openrouter`). Other providers ignore those keys. Claude allows four marks; the third and fourth (Grok Build marks the user message before the previous reply) wait for step 5, with the rest of the cache work.

## Errors

| Case | Tau does | Reference |
| --- | --- | --- |
| Effect marks the error retryable (rate limit, network, server error, unreadable reply) | Up to 4 retries; waits 2, 4, 8, 16 s with jitter, or the provider's `retry-after` when it is longer | OpenCode `session/runner/retry.ts` (10 retries, 2 s to 10 s); agreed in [loop-research.md](../loop-research.md) |
| `retry-after` longer than 2 minutes | No retry; the run fails and says when to try again | OpenCode caps at 15 minutes |
| ChatGPT plan: 429 with `error.type: "usage_limit_reached"` and `resets_at` | No retry. "Your ChatGPT plan reached its usage limit. It resets at 18:40. Usage: <https://chatgpt.com/settings/usage>" | Codex `codex-api/src/api_bridge.rs` |
| Claude plan: 429 with `anthropic-ratelimit-unified-status: rejected` and `anthropic-ratelimit-unified-reset` | The same, with <https://claude.ai/settings/usage> | oh-my-pi `anthropic-slow-mode.ts`; not seen live |
| Not retryable (bad key, bad request, content policy) | The run fails with the error's text, as today | |
| Reply ends with finish reason `length` | The run ends as `output-limit`, so the user can tell it from an answer | DeepSeek, oh-my-pi |

```text
call the model:
  retry (schedule above, while the error is retryable):
    stream the reply; on failure save its text as an interrupted reply (the slice 4a rule)
    emit { type: "retrying", attempt, delay, message } before each wait
  save the reply
  end as output-limit when the finish reason is length; continue when it calls tools; else answered
```

- Retries count in memory inside one model call. After a crash the count starts again, which is harmless.
- A retry after text was already streamed: the text is saved as interrupted and left out of the retry. Print mode prints a line on stderr; the partial text stays on stdout.
- `src/ai/plan-limits.ts` wraps the model only for the `anthropic`, `chatgpt` and `codex` routes. It reads the status, headers and body that Effect keeps on the error (`AiError` `http`). Effect's `QuotaExhaustedError` already has `resetAt` and is never retried, so the retry code needs no special case.

## Files

```text
src/core/instructions.ts    InstructionSource, read and compare, render the entry
src/core/sources.ts         the built-in sources: AGENTS.md files, date, environment, files
src/core/failure-text.ts    the text a failed run shows, including the plan message
src/core/operations.ts      + updateInstructions; callModel retries and ends at the output limit
src/core/client.ts          + "retrying" event; RunEnd + "output-limit"
src/session/entry.ts        + InstructionsEntry; tool results + files
src/sandbox/sandbox.ts      file functions report the paths they touch
src/session/context-view.ts system prompt from the newest "system" entry; notes as user messages; cache marks
src/ai/plan-limits.ts       429 on a plan route → QuotaExhaustedError with resetAt
src/ai/routes.ts            + usage page on the claudeSubscription, codexLogin and chatgptApp logins
src/cli/print.ts            stderr lines for "retrying" and "output-limit"
```

Replaced: `Prompt.setSystem(contextView(entries), BASE_PROMPT)` in `operations.ts` (the context view builds the system prompt); the raw `error.message` in `runEnded`. Removed from [deferred.md](../deferred.md): "ChatGPT plan usage-limit errors".

## Tests

- **Agent loop** (`tests/agent-loop.test.ts`, scripted model, real files): the first model call has `AGENTS.md` and the date in the system prompt; editing `AGENTS.md` mid-run adds one note and leaves the system prompt the same; reading a file under a folder with its own `AGENTS.md` adds that file as a note once; creating a file adds a `Files added` note; a scripted rate limit is retried and the run answers; five failures end the run as failed; a `length` finish ends as `output-limit`; the system prompt and last message of each request carry a cache mark. Retry waits use `TestClock`, so no test sleeps.
- **Plan limits** (`tests/models.test.ts`, replay server): a ChatGPT 429 becomes the plan message and is sent once. The 429 recording is written from Codex's documented body until a live one is captured.
- **Recognizer**: a table test of the pure function that reads a 429.
