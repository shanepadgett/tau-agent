# Web search, web fetch and references

Status: round 1 (web) and round 3 (the web code-level plan) agreed 2026-10-15. Web is built (2026-10-15); its live check is in [live-checks.md](../live-checks.md). Round 2 (the references design and mockups) agreed 2026-10-15. Round 4 (the references code-level plan) agreed 2026-10-15.

Two pieces of work, web first. **Web**: the model can search the web and read a page from a `run` script. **References**: the user keeps a library of reference repositories (read-only git clones of other projects) and attaches some of them to a session, so the model knows where they are. Both are built-ins from `main` that [features.md](../features.md) lists for step 7; like `/commit`, they are built in core now and move onto the extension SDK in step 7.

## What exists

| Where | What it has |
| --- | --- |
| `main`, `packages/agent/extensions/web/` | `websearch` and `webfetch`, reachable only from code mode scripts, plus a system prompt section telling the model to use them from scripts. |
| `main`, `web/search.ts`, `hosted-search.ts`, `exa.ts` | Search runs a quick model of the session's provider with the provider's own search tool (OpenAI Codex, Anthropic, xAI), and falls back to Exa's hosted MCP endpoint (no key needed, optional `EXA_API_KEY`). Exa calls start at least 2 s apart. |
| `main`, `web/webfetch.ts` | `fetch` with a browser user agent, a 5 MB cap, Cloudflare challenge retry, HTML to Markdown with turndown, binary refused. |
| `main`, `packages/agent/extensions/reference/` | `/reference`: a picker over `~/.local/share/tau-agent/references/` whose Enter writes "Reference repositories: … Request:" into the input. Runs git for every repository before it shows; slow to open. |
| Here, `core/internal/run-tool/run-tool.ts` | The `run` description lists every function with its signature, groups included (`tools.process.start`). Only `skills` is left out and found with codemode's `search`. |
| Here, `ai/Models.ts` | `smallModel(ref)`: the cheap model of a provider, used by notes, memory and `/commit`. |
| Here, `@effect/ai-anthropic`, `@effect/ai-openai` | `AnthropicTool.WebSearch_20250305` and `OpenAiTool.WebSearch`, search tools run on the provider's side. Not yet used through Tau's routes. |
| Here, instruction sources (`core/internal/instructions/sources.ts`) | Keyed values read before each model call. Values present at the last compaction are in the system prompt; a later change is appended once as a note. |
| Here, sidebar (`work/sidebar.md`) | Context, Cost, Processes, Compaction sections. |

## Web (agreed 2026-10-15)

| # | Decision |
| --- | --- |
| 1 | Listed in `run`'s description as `tools.web.search` and `tools.web.fetch`, always present on every route, so the description never changes in a session. Their descriptions replace `main`'s system prompt section. |
| 2 | Search covers Anthropic, OpenAI and Exa in the first build. Exa queues calls made at the same time, starting each at least 2 s after the one before. |
| 3 | Hosted search runs on `Models.smallModel` of the session's model. |
| 4 | Fetch turns HTML into text with Bun's `HTMLRewriter`: only agents read it. No new dependency. |
| 5 | OpenRouter and OpenCode Go sessions search with Exa, not OpenRouter's paid `web` plugin. |
| 6 | Search always follows the session's provider: its small model with the provider's search tool, else Exa. No setting picks another route. |

```mermaid
flowchart LR
  S["tools.web.search"] --> P{"session provider"}
  P -->|anthropic, Claude subscription| A["small model + Anthropic web search"]
  P -->|openai, chatgpt, codex| O["small model + OpenAI web search"]
  P -->|openrouter, opencode-go, or hosted failed| E["Exa, queued"]
  F["tools.web.fetch"] --> H["HttpClient GET"] --> T["HTMLRewriter to text"]
```

- **Why a model runs search.** Anthropic and OpenAI have no plain search endpoint. Web search is a tool attached to a normal model request: the model writes the queries, the provider runs them, and the model answers with cited sources. So each hosted search is one small-model call.
- A function's result goes to the script, not the model, so `fetch` returns the whole page (up to 5 MB) and the script prints what it needs. `main`'s temporary output store is not rebuilt.
- Network calls use Effect's `HttpClient`, as `ai/` does, so tests inject replies.
- Risk: provider search through the Claude subscription and Codex routes is untested. The first build step proves each route live; a route that fails uses Exa.

## Web code-level plan (round 3, agreed 2026-10-15)

| # | Decision |
| --- | --- |
| 7 | A `hostedSearch` field on each provider in `Providers.ts` says which search tool it accepts. Provider IDs are not switched on in the web code, and the protocol cannot decide (OpenCode Go serves some models over the Anthropic protocol). |
| 8 | Fetch has no Cloudflare challenge retry in the first build; it comes back if pages fail. |
| 9 | Scripts get `SearchResult` and `FetchResult` as typed below. |

### What exists

| Piece | Today |
| --- | --- |
| `runner.ts` `runToolOf` | Builds the `run` functions of one run: `sh`, file functions, `history`, `tools.process.*`, `tools.skills.*`. |
| `core/Agent.ts` | Builds `RunServices` once per process (`writeQueue` is shared by every session this way). |
| `Models.languageModel` | `anthropic` protocol uses `AnthropicLanguageModel`, `openaiResponses` uses `OpenAiLanguageModel`. Both accept provider-defined tools in a `Toolkit`. |
| `OpenAiLanguageModel` | Adds `include: web_search_call.action.sources` by itself when `OpenAiTool.WebSearch` is in the toolkit, so Codex needs nothing extra. |
| `effect/ai` `Response` | Citations arrive as `UrlSourcePart` (`type: "source"`, `sourceType: "url"`). |
| `main` `search.ts` | Hosted search gets 70% of the time budget; Exa gets the rest. Errors map to a fallback reason. |

### Files

```text
src/ai/Providers.ts                     + hostedSearch: "anthropic" | "openai" | undefined on each provider
src/core/Web.ts                         the Web service: search (hosted, then Exa) and fetch
src/core/internal/web/
  hosted-search.ts                      small model + provider search tool; text and UrlSourceParts
  exa.ts                                Exa MCP call over HttpClient; 2 s start queue
  fetch-page.ts                         HttpClient GET, 5 MB cap, binary refused, HTMLRewriter to text
  web-functions.ts                      WEB_GROUP = "web"; tools.web.search and tools.web.fetch
src/core/internal/runner/runner.ts      RunServices + web; runToolOf adds [WEB_GROUP]
src/core/Agent.ts                       passes Web to the runner
src/cli/internal/agent-session.ts       provides Web.layer once per process
docs/guide/web.md                       what the model can do, routes, EXA_API_KEY
tests/core/web.test.ts                  routes and fallback with recorded replies
```

### Types

```ts
// Providers.ts: which provider-side search tool the provider's models accept.
readonly hostedSearch: "anthropic" | "openai" | undefined;

// What a script passes; web-functions fills the defaults (8 sources, 25 s; fetch 30 s).
type SearchInput = { query: string; maxSources?: number; timeoutSeconds?: number };
type Source = { url: string; title: string };
type SearchResult = {
  text: string;                 // the small model's answer with inline links, or Exa's text
  sources: readonly Source[];
  route: "anthropic" | "openai" | "exa";
  fellBack?: "timeout" | "failed"; // why hosted search gave way to Exa
};

type FetchInput = { url: string; timeoutSeconds?: number };
type FetchResult = { url: string; status: number; contentType: string; text: string };

class Web extends Context.Service<Web, {
  search: (model: ModelRef, conversationId: ConversationId,
    input: { query; maxSources; timeout: Duration }) => Effect<SearchResult, SearchFailed>;
  fetch: (url: string, timeout: Duration) => Effect<FetchResult, FetchFailed>;
}> { static layer: Layer<Web, never, Catalog | Models | HttpClient> }
```

### Call path

```mermaid
sequenceDiagram
  participant S as run script
  participant F as web-functions
  participant W as Web.search
  participant H as hosted-search
  participant E as exa
  S->>F: tools.web.search({ query })
  F->>W: search(run model, input)
  W->>H: provider.hostedSearch set
  H-->>W: text + sources, or failure
  W->>E: no hostedSearch, or failure
  E-->>W: text
  W-->>S: SearchResult
```

```text
search(model, input)
  provider = catalog provider of model
  if provider.hostedSearch
    small = models.smallModel(model)
    language = models.languageModel(small, "<session>:web")
    tool = anthropic ? AnthropicTool.WebSearch_20250305({ maxUses: 3 }) : OpenAiTool.WebSearch({})
    reply = language.generateText(instructions + query, toolkit [tool], toolChoice required)
      within 70% of the timeout
    return text and url sources of reply, route provider.hostedSearch
    on failure remember the reason and go on
  wait for Exa's turn (one start per 2 s, shared by every session)
  return Exa text, route exa, fellBack reason

fetch(input)
  GET url with a browser user agent, within the timeout
  refuse a body over 5 MB, or a type that is not text, HTML, JSON or XML
  HTML: HTMLRewriter drops script, style, nav; keeps text, headings, links as "text (url)"
  return status, type, text
```

### Injection

| | Production | Tests |
| --- | --- | --- |
| Hosted search | `Models.layer` over `FetchHttpClient` | `Models.layer` over an `HttpClient` that replays recordings in `tests/recordings/` |
| Exa and fetch | `FetchHttpClient` | the same replaying `HttpClient` |
| Exa queue | 2 s between starts | `TestClock` |

### Replaces

`main`'s system prompt section (`guidance.ts`), its temporary output store (`tool-output.ts`), turndown and its GFM plugin, and the xAI route.

## References (round 2, agreed 2026-10-15)

The library and the session are separate, as with favorite models. The library is every clone in the references folder; `/references` adds, updates and removes clones. Attaching a reference to a session is a separate toggle in the same panel. Attached references show in the sidebar, and the model learns their names and folder from an instruction source, not from the prompt.

```mermaid
flowchart LR
  C["/references panel"] --> L["library: references folder"]
  C --> A["attach or detach"] --> E["session entry: attached names"]
  E --> I["instruction source tau/references"] --> M["system prompt or appended note"]
  E --> B["sidebar: References"]
```

- **Cache stable.** Attached before the first message, the list is part of the system prompt. Attached later, it arrives as one appended note, and folds into the system prompt at the next compaction, as instruction files do.
- **What the model reads:**

  ```text
  Reference repositories are read-only git clones in ~/.tau/references/<name>.
  When the user names one, read it there. Never change them.
  Attached: opencode, opentui
  ```

- **Where the attached list lives.** A new session entry, `{ type: "references", names }`, appended on each change; the newest wins. Forks keep it. A name whose folder is gone is dropped from the source.
- **No lag.** The panel lists folder names at once and reads each branch from `.git/HEAD` as a file, with no git process. Git runs only for actions.
- **Folder.** `~/.tau/references/`, next to Tau's other files (`settings.json`, `sessions.db`, `skills/`). Tau does not move `main`'s clones; `mv ~/.local/share/tau-agent/references ~/.tau/references` does.

### Mockup

`>` marks the cursor row. Parentheses are drawn muted. Attached references sit above the divider, as favorites do in `/model`.

1. Two attached, no filter.

```
┌References──────────────────────────────────────────────────────────┐
│Type to filter                                                      │
│                                                                    │
│opencode (dev)                                                      │ >
│opentui (main)                                                      │
│────────────────────────────────────────────────────────────────────│
│effect (main)                                                       │
│mastra (main)                                                       │
│pi (main)                                                           │
└enter attach · ^n new · ^r branch · ^u update · ^o open · ^x delete─┘
```

1. Enter on a row moves it across the divider (attach or detach), as Ctrl+F does in `/model`. Typing filters both sections; nothing matching leaves only the input.

2. Ctrl+N: the input asks for a URL. Enter starts the clone and returns to the list, where the new row shows progress, then its branch.

```
│Git URL: https://github.com/anomalyco/opencode                     │
...
│codex (↓ 37%)                                                       │
```

1. Ctrl+U updates every clone (`git pull --ff-only`); each row shows `(…)`, then `(✓)` or `(! not fast-forward)`. The panel stays usable.

2. Ctrl+R: the list becomes the cursor row's branches, filtered by typing; Enter switches, Esc goes back.

```
┌Branch of opencode──────────────────────────────────────────────────┐
│Type to filter                                                      │
│                                                                    │
│dev (current)                                                       │ >
│main                                                                │
└enter switch · esc back─────────────────────────────────────────────┘
```

1. Ctrl+X: the hint line asks `Delete opencode from disk? y / n`. Deleting an attached reference detaches it.

2. Ctrl+O opens the folder in `$VISUAL`, else `$EDITOR`, else `code`.

3. Empty library: `No references. ^n adds one from a git URL.`

4. A failed clone, pull or branch switch: the row shows `(! <first line of git's error>)` until the next action on it.

Sidebar, below Processes:

```
│ References                             │
│ opencode                               │
│ opentui                                │
```

Empty: `References   None attached`.

## References code-level plan (round 4, agreed 2026-10-15)

### What exists

| Piece | Today |
| --- | --- |
| `Picker.tsx` | Filtered list with sections and a divider; Enter calls `choose` and closes; Ctrl+F calls `mark`. `/model` and `/sessions` use it through `chat-commands.ts`. |
| `FavoriteModels` | Interface in `core/`, file-backed layer in `host/`, exposed through `Agent`. The library half of references copies this. |
| `instructions/sources.ts` | Sources get `entries`, so one can read a session entry (as `skillListSource` reads saved values). |
| `Sessions.append`, `fork` | Fork copies entries up to a number, so a `references` entry survives forks with no code. |
| `processes-changed` event, `SessionPanel.tsx` | The pattern for a sidebar section fed by an event. |
| `runProgramWith` | Runs a program and gives its output when it ends. No line streaming, so clone progress uses the process spawner directly (`ChildProcessSpawner`, as `Command.ts` does) and reads stderr as a stream. |

### Shape

Two parts that meet only at attached names. The **library** is global: the folder and git work, behind a `References` service like `FavoriteModels`. **Attachment** is per session: an entry, an instruction source and a sidebar section.

```mermaid
flowchart LR
  P["references panel"] --> R["References service: folder and git"]
  P --> S["OpenSession.references: attach, detach"]
  S --> E["entry: references"]
  E --> I["instruction source"]
  S --> V["event: references-changed"] --> B["sidebar"]
```

Picker shape, two options: (a) widen `Picker` with row actions, a text-input mode and a stay-open flag; (b) a separate `ReferencesPanel.tsx` that reuses `filteredList`. Recommend (a): (b) copies the filter, cursor, scroll and divider code, and `/model` and `/sessions` take the same widening for free. The panel's modes (list, URL, branches, delete) are a small state machine in `references-picker.ts`, not flags in `Picker`.

### Files

```text
src/core/References.ts                 service interface (library), ReferenceFailed
src/host/References.ts                 layer: folder reads, .git/HEAD, git clone/pull/switch, rm, editor
src/core/internal/references/references-source.ts   instruction source tau/references
src/session/Entry.ts                   + ReferencesEntry { type: "references", names }
src/core/internal/runner/runner.ts     OpenSession.references; appends the entry; publishes the event
src/core/Client.ts                     + AgentEvent "references-changed"
src/core/Agent.ts                      exposes References["Service"] as `references`
src/tui/internal/Picker.tsx            + actions, text-input mode, keepsOpen (widened)
src/tui/internal/references-picker.ts  the panel's state machine; builds PickerLists
src/tui/internal/chat-commands.ts      + /references
src/tui/internal/chat-state.ts         + references: readonly string[]
src/tui/internal/SessionPanel.tsx      + References section below Processes
docs/guide/references.md               the command, keys, folder, what the model sees
tests/host/references.test.ts          temp folder and a local bare repo: list, clone, pull, branches, delete
tests/core/references.test.ts          source text, attach/detach entries, dropped missing folder
```

### Types

```ts
type CloneProgress = { phase: "receiving" | "resolving" | "updating"; percent: number }; // parsed from git clone --progress stderr
type Reference = { name: string; branch: string | undefined }; // branch from .git/HEAD; a detached head shows the short hash

class References extends Context.Service<References, {
  list: Effect<readonly Reference[]>;                       // folder names + .git/HEAD, no git process
  clone: (url: string, onProgress: (progress: CloneProgress) => Effect<void>) => Effect<Reference, ReferenceFailed>; // built as a callback, not a Stream; name = last URL segment without .git; ends when the clone is in place
  update: (name: string) => Effect<void, ReferenceFailed>;      // git pull --ff-only
  branches: (name: string) => Effect<readonly string[], ReferenceFailed>;
  switchBranch: (name: string, branch: string) => Effect<Reference, ReferenceFailed>;
  remove: (name: string) => Effect<void, ReferenceFailed>;
  open: (name: string) => Effect<void, ReferenceFailed>;    // $VISUAL, else $EDITOR, else code
}>

// ReferenceFailed.message is the first line of git's output.
// clone follows main: `git clone --progress --single-branch` into `.clone-<name>-<id>` in the references folder, renamed on success, removed on failure or cancel, killed after 180 s with no output. list skips `.clone-*`.

// OpenSession gains:
references: {
  attached: Effect<readonly string[], SessionStoreError>;           // newest references entry
  set: (names: readonly string[]) => Effect<void, SessionStoreError>; // appends the entry, publishes the event
};

// Entry: { type: "references"; names: readonly string[] }
// Event: { type: "references-changed"; names: readonly string[] }

// Picker widening
type PickerAction = { key: string; hint: string; run: (item: PickerItem | undefined) => void };
type PickerList = { title; sections; actions: readonly PickerAction[]; hint: Accessor<string>;
  placeholder: Accessor<string>; submit?: (text: string) => void;  // text-input mode
  back?: () => void; keepsOpen?: boolean };   // Esc calls back when set, else closes
```

`mark`/`markHint` become one `PickerAction` on Ctrl+F, so `/model` changes by a few lines.

### Call path and logic

```text
/references
  library = agent.references.list; attached = opened.references.attached
  open panel in mode list

panel (mode list)
  sections = [attached rows, other rows]; row label = name, note = branch or its action state
  enter: toggle name in attached; opened.references.set(new list); stay open
  ctrl+n: mode url (placeholder "Git URL", submit = clone; row note "↓ 37%" from each progress item, then the branch)
  ctrl+r: mode branches of cursor row; enter switches, esc back
  ctrl+u: for each name, 4 at a time: note "…", agent.references.update, note "✓" or "! first line"
  ctrl+x: mode delete (hint "Delete <name> from disk? y / n"); y: remove, detach if attached
  ctrl+o: agent.references.open(name)
  an action's failure sets the row note to "! <message>" until the row's next action

source tau/references (reads entries)
  names = names of the newest references entry, kept where <references folder>/<name> exists
  none if empty
  first   = folder text + "Attached: " + names
  changed = "The attached references are now: " + names
  removed = "No references are attached any more."
```

The source needs the references folder, so `Where` in `sources.ts` gains it from `References`. Row state (clone progress, updating, errors) lives in the panel, not in the service.

### Injection

| | Production | Tests |
| --- | --- | --- |
| Folder | `TauHome` directory + `references/` | temporary `TauHome` |
| Git | real `git` through `runProgramWith` | a bare repo made in the test folder as the clone URL |
| Editor | spawns `$VISUAL`/`$EDITOR`/`code` | not tested; `open` is a single spawn |
| Panel state machine | `references-picker.ts` over `Agent["Service"]["references"]` | a fake service, as `chat-state.test.ts` does |

### Replaces

`main`'s `reference` extension (the `/reference` picker that wrote text into the input, and its per-repository git calls on open). Nothing in this branch is removed.


## References: repository description (considering, 2026-10-15)

Show a muted, single-line description after the branch in each row, cut with `…` at a width limit. Agreed and built 2026-10-15 with the recommended source below. Live check pending.

Sources for the text:

| Source | Network | Notes |
| --- | --- | --- |
| GitHub API `GET /repos/{owner}/{repo}` at clone time | once per clone, github.com URLs only | The text GitHub shows. Saved in `.git/tau-description`, so listing stays offline and runs no git. Existing clones have none until the user presses a refresh key. Rate limit 60 per hour without a token. |
| First paragraph of the README | none | Works for any host and existing clones. Often a badge line or a title, not a description. |

Recommendation: GitHub API at clone time, with the README line as the fallback for other hosts and for existing clones.

Mockup (80 columns; branch is plain text, description is muted and cut to fit):

```
References
  opencode    dev   Open source AI coding agent built for the terminal
  opentui     main  Terminal UI framework for TypeScript and Zig, with…
  ──────────
  codex       ↓ 37%
  pi          main  A minimal terminal coding harness
```


## Multi-select picker (considering, 2026-10-15)

A picker where the user marks several items and confirms them together, with the same type-to-filter input. Not designed yet; the use is open (see questions.md).

Proposed keys. The input stays focused so letters and Space always filter:

| Key | Action |
| --- | --- |
| Tab | Mark or unmark the row, then move down |
| Shift+Tab | Mark or unmark the row, then move up |
| Ctrl+A | Mark every row the filter shows, or unmark them when all are marked |
| Up, Down | Move |
| Enter | Confirm the marked rows; with none marked, confirm the row under the cursor |
| Escape | Cancel without applying |

Marks stay when the filter changes. Rows show `[x]` or `[ ]`, and the hint line shows the count. Build it as a `multi` option on `Picker` (marked ids, `confirm(ids)`), not a new component.

Decision 2026-10-15: build `multi` on `Picker` and move `/references` onto it. The marks start as the attached set. Enter applies the marks as the session's attached list; Escape cancels. The mockup below waits for approval before any code.

```
Before (today)                                    After
References                                        References
  opencode (dev)  The open source coding agent.     [x] opencode (dev)  The open source coding agent.
  ──────────                                        [ ] pi (main)       AI agent toolkit: unified LLM…
  pi (main)  AI agent toolkit: unified LLM…         [ ] codex  ↓ 37%
  Type to filter                                    Type to filter
  enter attach · ^n new · ^r branch …               2 attached · tab mark · enter apply · ^n new · ^r branch · ^u update · ^o open · ^x delete

Filtered ("pi"), mark kept from before          Nothing in the library
  [x] opencode is hidden but still counted          No references. ^n adds one from a git URL.
  [ ] pi (main)       AI agent toolkit…             0 attached · ^n new
  Type to filter: pi
  2 attached · tab mark · enter apply
```

Built 2026-10-15. Differences from the table above: Enter confirms exactly the marked set (an empty set detaches everything), so references can detach all; the count is in the title (`References · 2 attached`) and the bottom line reads `tab mark · enter ok · ^n new · ^r branch · ^u pull · ^o open · ^x del` so it fits 80 columns (a longer line is not drawn).
