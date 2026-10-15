# SDK catalog: what each area offers extensions

Status: round 2 of the [SDK](sdk.md) agreed.

[sdk.md](sdk.md) settled the shape:

- An extension gets a context with one area per part of Tau, and only the areas it asks for.
- Each area offers up to four kinds of extension point: **watch** (read events), **intercept** (hooks at one boundary: `transform`, `guard` or `wrap`), **contribute** (add to a registry) and **replace** (swap a whole runtime part; Tau's default is built the same way).

This round lists the areas and what each offers. Names are working names; the events and hooks per area get their exact lists when each area is built.

## Areas

| Area | Watch | Intercept | Contribute | Replace | Built on |
| --- | --- | --- | --- | --- | --- |
| `sessions` | entries appended (facts); text and progress (signals) | none | entry types with their schemas; projections that rebuild extension state from entries; custom messages in the chat, optionally starting a turn; steering and follow-up messages; child sessions | none | `session`, `core` |
| `turn` | turn started and ended; which operation each step ran | `transform` the request before it is sent | operations in the `input`, `tools` and `recovery` phases | none: the loop guarantees cancellation, one writer per session and rebuilds after a crash | `core` turn loop |
| `instructions` | none | none | instruction sources | the base prompt, before the session's first model call | `core` |
| `context` | none | `transform` the built context | none | building what the model sees from the session's entries | `session` context view |
| `compaction` | started, placed, dropped | none | none | when to compact, and what the summary is | `session` algorithm, `core` scheduling |
| `models` | usage per call | `wrap` every model call (audit, redaction) | model routes | choosing the model for each request | `ai` `Models` |
| `functions` | call started and finished | `guard` a call (approval); `transform` a result (redaction); `wrap` execution | `run` functions with Schema parameters, grouped, optionally deferred | none | `core` `run` tool, `sandbox` |
| `checks` | results | none | check entries and check providers | none | `core` `checks` tool |
| `tasks` | status of each background task and process session | none | background tasks and process sessions (such as a dev server), shown in the sidebar | none | `core` background tasks, `proc` |
| `workspace` | files each `run` call changed | none | none | none | `workspace` change detection |
| `commands` | none | none | slash commands, keybindings | none | `host`, `tui` |
| `ui` | through `sessions` | none | components added to named places; dialogs, notifications | any named place | `tui` |
| `settings` | changes to this extension's settings | none | the extension's settings schema | none | `host` settings |
| `storage` | none | none | none | none | `host`: a key-value store per extension that lasts across sessions, for memory, stats or caches; no extension sees another's |
| `services` | none | none | extension points this extension publishes | none | SDK registry |

`models` calls are text, structured output (with or without tools) and decisions, over the same routes Tau uses, without credentials. A model route an extension contributes declares the key it needs (settings name and environment variable); Tau stores the key and signs requests. A subagent is a child session from `sessions`, started by a function the extension contributes. State an extension rebuilds from `sessions` entries follows the branch the user is on.

## Replaceable runtime parts

| Part | Tau's default | Why replaceable |
| --- | --- | --- |
| Compaction | background compaction from [features.md](features.md#context) | Pi allows only nudging it through events |
| Context building | latest summary, then every entry after its cut | Retrieval, pruning or summarizing tool output |
| Model selection | the prompt classifier's routing | A cost-based or task-based router |
| Base system prompt | Soul | A different persona or a minimal prompt; fixed once the first model call is sent |
| UI places | Tau's own panels, editor and renderers | Everything the TUI shows (next table) |

## Stable prefix

Providers cache by prefix, so these points only grow at the end between compactions:

- **The base prompt** can be replaced until the session's first model call, then stays fixed.
- **Everything else the model is told** comes from instruction sources, as in OpenCode's session design: the date and environment, `AGENTS.md` files, skills, the function catalog, and anything extensions contribute. A source has a key, a `read`, and three renderings: `initial`, `changed` and `removed`. Before each model call Tau reads every source and records which ones changed. The system prompt shows each source's value as of the last compaction; a later change is rendered once and appended to the chat as a short note, such as "Today's date is now …". Compaction makes the current values the new baseline. Extensions never touch the system prompt text, so they cannot break the cache by accident.
- **Sources are ordered most shared first:** the function catalog and user-level guidance, then project instructions, then the date and environment, so the prefix also repeats across sessions.
- **A replaced context builder and the `context` `transform` hook** rewrite fully only at compaction; between compactions they may only add at the end.
- **The function catalog is a source**, so a function found or added mid-session is appended as a catalog update and the `run` tool's schema never changes.
- Tau checks each turn's context against the last one and reports an extension that breaks the prefix.
- Changing the model loses the cache, so a replaced model selection should switch only when it is worth that cost.

## Named UI places

Few and coarse, as OpenCode keeps its slot tree, so they stay stable while the TUI changes underneath. An extension adds before, after, at the start or end of a place, or replaces it. A replaced place keeps its boundary, so other extensions' additions around it still show.

| Place | Holds |
| --- | --- |
| `app` | The whole screen: layout of header, sidebars, chat, input and overlays |
| `header` | Session title, model, current branch, running activity |
| `sidebar.left` | Extension panels; empty by default |
| `sidebar.right` | Tau's panels (context use, cost, processes, tasks) and extension panels |
| `chat` | The transcript |
| `chat.entry.<type>` | How one entry type renders, including extension entry types |
| `chat.function.<name>` | How one `run` function's calls and results render |
| `input` | The block holding the three places below |
| `input.above` | Short live items while typing. Tau's default is the message queue: steering and follow-ups waiting to be sent, editable or cancellable. Extensions add a compact to-do list, a pending approval, attachments, subagent chips |
| `input.editor` | The input editor |
| `input.below` | The status line under the input |
| `overlay` | Floating layers above everything |

Layout rules:

- An empty place takes no space; the left sidebar appears only when something is put there.
- Below a width set in settings, sidebars hide and a key toggles them.
- Items from several extensions in one place stack in the order the extensions are enabled.
- `input.above` has a height cap and scrolls beyond it, so it cannot push the chat off screen.

Components receive the session's facts and signals reactively and can send commands, such as cancelling a child session.

## Not areas

These come from other parts of the plan:

- Credentials: never reachable.
- The database: extensions store state only as their own session entries, settings or `storage`.
- The `run` sandbox internals.
- Skills, prompt templates and themes, which are package contents (round 3).
