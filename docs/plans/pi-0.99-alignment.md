# Pi 0.99 alignment analysis

Scope: what Pi 0.87.1, 0.99.0, and 0.99.1 change for Tau, and what each Tau extension should do about it. Installed Pi is 0.87.0 (`package.json` pins `pi-ai`, `pi-coding-agent`, `pi-tui` at 0.87.0).

Method: read the changelog, the extension, MCP, CLI, settings, session-format, and virtual-model docs, the 0.99.1 type declarations (`npm pack`), and Tau's extension source. Tau was not run against 0.99.1. Every "Verify" note is something the docs imply but I did not execute.

## 1. What actually changed

0.87.1 and 0.99.1 only add models. 0.99.0 is the large release. Several useful APIs also shipped in 0.84 through 0.87, so Tau already has them and does not use them.

| Pi feature | Since | Tau relevance |
| --- | --- | --- |
| Tool `exposure` (`direct`, `model-only`, `codemode`, `deferred`, `hidden`), `namespace`, `annotations`, `outputSchema` + `structuredContent`, `defaultActive` | 0.99.0 | Overlaps `tool-loader`. Lets Tau tools be scriptable and gate-able. |
| Built-in `codemode` (QuickJS sandbox calling tools) and `tool_search` | 0.99.0 | Overlaps part of `script_runner`, `tool-loader`, and the "fewer turns" goal of `patch`. Off by default. |
| `ctx.executeTool()` nested calls, `parentToolCallId`, nested usage rolled into the calling tool result | 0.99.0 | `tool-approval` sees nested calls. Cost accounting changes. |
| Built-in MCP (`mcp.json`, `/mcp`, `pi.registerMcpServer`) | 0.99.0 | Nothing to build. Approval policy needs to cover MCP tools. |
| Virtual models (`pi.registerVirtualModel`, `route()` with `reason`: `user`, `continuation`, `retry`, `direct`) | 0.99.0 | New way to route the main agent, compaction, and retries. |
| Classifier models (`ctx.modelRegistry.classify`, Jev, llama.cpp) | 0.99.0 | Possible cheap prefilter for `tool-approval`. |
| `ModelRuntime.generateImages` | 0.99.0 | Not reachable from extensions: `ctx.modelRegistry` is the `ModelRegistry` facade and has no `generateImages`. |
| `system` theme default, `theme.style()`, `theme.colors` | 0.99.0 | No action. Tau ships no themes (`packages/agent/themes` is empty). |
| Native transcript-backed prompt and tool patches (`sections`, `toolsAdded`/`toolsRemoved`, compaction checkpoint) | 0.86 | Overlaps `soul` and `tool-loader`. |
| `ctx.modelRegistry.stream()` / `streamSimple()` with resolved auth | 0.86 | Overlaps `model-fallback`, `aside`, `isolated-session`. |
| `agent_before_settle` / `turn_end` actionable boundaries, `continue: true` | 0.87 | Overlaps `silent-command-runner` and the `attention` hold protocol. |
| `ui_prompt_start` / `ui_prompt_end` | 0.84 | Overlaps `tau:agent.blocked`. |
| `ContextEditEntry`, `appendContextEdit(entryId, null)` | 0.87 | Enables pruning stale context without rewriting history. |
| Cache warming, `showCacheMissNotices`, `cache_warming_decision` | 0.86 | Partly overlaps `cache-diagnostics`. |
| GPT-5.4 and GPT-5.4 mini removed from OpenAI Codex | 0.86 | Breaks `auto-name`'s first model. |

Nothing in 0.99.1 breaks Tau's code on inspection: no Tau code uses `user_bash`, `sourceInfo`, or built-in tool names, and Tau registers no tool named `codemode`, `tool_search`, or `mcp`.

## 2. Findings by action

### Fix now (bugs and drift)

1. **Upgrade the three Pi pins to 0.99.1.** Run the full check suite after.
2. **`auto-name` model list is stale.** `AUTO_NAME_MODELS` starts with `openai-codex/gpt-5.4-mini`, which Pi removed in 0.86. It now always falls through to a free OpenRouter model.
3. **Model tables live in four places.** `shared/model-effort.ts`, `tool-approval` (`REVIEW_MODELS`), `auto-name`, and the `review` README. `docs/standards/agent-runtime.md` says extensions request a shared tier. `tool-approval` and `auto-name` do not. The `review` README says `gpt-5.6-sol` and `claude-opus-5`, but the code uses the `deep` tier (`gpt-6-astra`, `claude-opus-5.5`). Move approval and naming onto the `quick` tier, add GPT-6.1 Sol and Claude Sonnet 5.5 to the tiers, and fix the README.
4. **Dead subagent code.** Subagents were removed in `e378f69`, but `run-summary` still parses `subagentCost` and `cost-report` still builds subagent buckets. Project rules say no backward compatibility. Decision needed: keep reading old sessions in `cost-report` or drop it.
5. **`run-summary` under-counts cost.** `footer` and `cost-report` both sum assistant, tool-result, compaction, and branch-summary usage. `run-summary` summed assistant usage only. 0.99 puts nested-call and classifier usage on tool results, so it would under-report once codemode or classifiers run. (An earlier draft of this plan said `cost-report` also missed tool-result usage. That was wrong; it counts them.) Still to verify: where cache-warming refresh usage is recorded, so all three can count it.
6. **Anthropic model IDs in the `deep` tier never resolve.** The bundled 0.99.1 catalog uses hyphens (`claude-opus-5-5`, `claude-fable-5-1`, `claude-sonnet-5-5`). Tau listed `claude-opus-5.5` and `claude-fable-5.1`, which are not in the catalog. Catalog check also confirms `gpt-5.4-mini` is gone and that `gpt-6.1-sol`, `gpt-6-luna`, `gpt-6-sol`, `gpt-6-astra`, `grok-4.7`, `deepseek-v4.1-flash` exist.

### Replace with Pi (delete Tau code)

| Tau code | Replace with | Notes |
| --- | --- | --- |
| `shared/model-fallback` resolves `apiKey`/`headers`/`env` and calls `provider.streamSimple`; `aside` does the same | `ctx.modelRegistry.streamSimple()` | Drops the auth fields from `ModelCandidate`. Cooldowns and candidate ordering stay. `isolated-session` builds a session, so check it separately. |
| `silent-command-runner` (`agent_end`, `followUp` message, `chainActive`, attention hold events) | `agent_before_settle` returning `{ entries: [...event.entries, failureMessage], continue: true }` | Removes the chain state and the `tau:attention.hold.*` protocol. Needs a loop guard so a failing check does not continue forever. Run-summary's "full continuation chain" logic simplifies too. |
| `shared/agent-blocked.ts` and three callers (`tool-approval`, `qna`, `commit`) | `ui_prompt_start` / `ui_prompt_end` in `attention` | The native event also fires for user-started command panels. Gate on `!ctx.isIdle()`. |
| `tool-loader` (`load_tools`, pending/applied entries, `session_compact` replay, `tau:prompt.tools.check`) | Tool `exposure: "deferred"`, `namespace`, and built-in `tool_search` | Trade-off below. |
| `soul` baseline/update entries and `context_with_system` replay | Native `customPrompt` + `sections` from `before_agent_start` | Spike first. Details below. |

**tool-loader trade-off.** Pi's `tool_search` declares tools through transcript patches. On models that cannot represent that change, Pi sends a full checkpoint and the cached prefix is lost once. Tau's gate (`soul/tools.ts` `toolChangeReason`) queues the load until compaction instead. Options: accept one cache miss on unsupported models, or keep a small `tool_call` handler that blocks `tool_search` when `toolChangeReason` reports unsupported. The second keeps the guarantee but loses the queue-until-compaction behavior. Recommend the second: it is about 30 lines instead of 230.

**Soul spike.** Soul chose `context_with_system` over Pi's structured prompt because forcing the whole prompt defeated Pi's cache-preserving tool history (`soul-prompt-lifecycle.md`, deleted in `b09cfd1`). That note did not evaluate `customPrompt` + `sections`. In 0.87 `buildSystemPromptSections` with a `customPrompt` emits only `preamble`, `addendum`, `project_context`, `skills`, `cwd`, and custom sections. It omits Pi's tools, rules, and docs sections. Pi persists those sections in the first system message, diffs them on each request, appends a patch when they change, and writes a complete checkpoint at compaction.

If that holds, Soul reduces to:

```text
before_agent_start(event):
  opts.customPrompt = FIXED_INSTRUCTIONS
  opts.sections[section] = value for each registered prompt source
  // Pi persists, diffs, patches, and checkpoints
```

What stays in Tau: `FIXED_INSTRUCTIONS`, the prompt-source registry, a freeze rule for values that must not drift (date and root snapshot, refreshed after compaction), and optionally the prefix-hash guard. What goes: `SavedBaseline`/`SavedUpdate` entries, `projectPrompt`, `admittedTools`, the projection comparison, and the dependency on `buildSessionProjection`. Roughly 450 lines become 100.

The spike must confirm: (a) the section set above with `customPrompt`; (b) unchanged sections produce no patch across turns, reload, resume, and `/tree`; (c) a frozen date survives those paths and refreshes after compaction; (d) the cache-diagnostics fingerprint stays stable across consecutive requests. If (b) or (c) fails, keep Soul as is.

### Enhance

1. **`tool-approval`.**
   - Tau tools declare no `annotations`. Add `readOnlyHint` and `idempotentHint` to every `explore` tool, `list_windows`, and `websearch`/`webfetch`/`codesearch` (`openWorldHint: true` for web). Add `destructiveHint` to `patch`.
   - Extend approval to any active tool whose annotations are not read-only, using the Pi doc pattern. This covers MCP tools, `appshot`, and `image_gen`. Today only `bash` and `script_runner` are reviewed.
   - Nested calls from `codemode` reach `tool_call` handlers without appearing in the assistant message. The batch cache misses, so each nested `bash` gets its own reviewer call. Verify that parallel nested `bash` calls do not open overlapping approval panels.
   - Approval notes are appended to `content` only. For tools with an `outputSchema` (built-in `bash` now has one), scripts read `structuredContent` and will not see the note.
2. **`patch`.** Add `annotations` and an `outputSchema` for the summary. Return `isError: true` from `execute` for partial failures instead of the `tool_result` override. Keep the `tau:file-mutation.applied` emit.
3. **`explore`, `web`, `appshot`, `image-gen`.**
   - Register groups with `exposure` and `namespace` instead of `registerDeferredToolGroup`.
   - Add `outputSchema` and `structuredContent` to `discover`, `show`, `outline`, and the relationship tools so codemode scripts receive data, not text.
   - Measure whether the seven relationship tools (`deps`, `reverse_deps`, `callers`, `callees`, `references`, `implementations`, `impact`) should move to `exposure: "codemode"` and out of every request's declarations.
4. **`cache-diagnostics`.** Keep. Pi's notices report that a miss happened; Tau's report explains which request field changed. Recommend enabling `showCacheMissNotices` as the first alert and pointing it at `/cache-debug`. Its `PromptState` tracking simplifies if Soul moves to native sections.
5. **`qna`.** Register `ask_question` as `exposure: "model-only"` with `defaultActive: false`.
6. **`footer`.** It shows `ctx.model`, which is the virtual selection. If a virtual model is adopted, show the routed model from the latest assistant message.
7. **`/tau doctor`.** Add checks for the Pi version, `defaultTools`, `cacheWarming`, `showCacheMissNotices`, and model IDs in Tau's tables that are absent from the catalog.
8. **Fullscreen TUI (0.84).** Test the Tau footer, `aside` widget, overlays, and entry renderers in `--tui-mode fullscreen`. Decide whether `clear-screen` still means anything there.
9. **`context`.** Later: use `appendContextEdit(id, null)` to omit superseded file injections and reads after `patch` changes a file. It moves the cache prefix at the edit point, so apply it only at compaction or branch boundaries.

### Add

1. **`tau/auto` virtual model, v1 = `direct` and `retry` only.**
   - `direct` requests (compaction summaries, extension model calls) route to the `quick` tier. Compaction currently runs on whatever expensive model the session uses.
   - `retry` requests fail over across providers using the existing cooldown list. Tau has failover for side calls but none for the main agent.
   - `user` and `continuation` stay on the previous model (`request.previous`), so there is no cache risk.
   - Do not add plan-then-implement switching in v1. Each switch costs one prompt-cache miss, and Tau removed the `effort` extension on purpose. Ask before revisiting.
2. **Codemode trial (measure before deciding).** Add `"defaultTools": ["+codemode"]` in a test profile with `codemode.mode: "on"`. It can run several `explore` calls in parallel and filter large `bash` output before it reaches context. Read-only nested calls need no approval, which lowers review load compared with `script_runner`. Costs: up to 3000 estimated tokens of description, the model must write JavaScript, and approval behavior for nested `bash` is unverified. Run five repeated tasks with and without it and compare tokens, turns, and cost. `script_runner` stays regardless: it runs Python and Deno on the host, which codemode cannot.
3. **Classifier prefilter for `tool-approval` (experiment).** Classify `approved` versus `requires_user_approval` first and call the reviewer model only when the label is not clearly approved or when a human summary is needed. Needs a TypeSafe key or a local llama.cpp classifier. I have not seen classifier accuracy for this task, so do not commit to it before a trial.

### Keep unchanged

`appshot`, `aside` (apart from `streamSimple`), `branch`, `commit`, `handoff`, `ideas`, `manage-sessions`, `patch` (apart from the items above), `ready`, `reference`, `review`, `script-runner`, `stash`, `tau-help`, `runtime-context`, `web`, `auto-name` (apart from models).

`image-gen` stays, blocked. `src/image-generation` (about 600 lines, including the ChatGPT account-ID header handling) could be replaced by `ModelRuntime.generateImages`, but extensions cannot reach it. Revisit if Pi exposes it on `ModelRegistry`.

MCP needs no Tau work beyond the approval annotation policy above.

## 3. Suggested order

Each slice leaves the tree green and wired.

1. Pin bump, model-table consolidation, `auto-name` fix, `review` README, `run-summary` and `cost-report` cost counting.
2. `ctx.modelRegistry.streamSimple` in `model-fallback` and `aside`.
3. `agent_before_settle` in `silent-command-runner`, then remove attention holds. `ui_prompt_*` in `attention`, then delete `agent-blocked.ts`.
4. Annotations and `outputSchema` pass over Tau tools, with annotation-based approval.
5. Soul spike. Decide, then rewrite or stop.
6. `tool-loader` replacement (depends on the Soul outcome for the gate).
7. Codemode trial. `tau/auto` v1.

## 4. Decisions (recorded)

1. Start all slices: drift fixes, `streamSimple`, settle boundary and `ui_prompt_*`, annotations and approval, Soul spike (no production change), `tau/auto` v1 (`direct` and `retry` only), codemode trial.
2. `tool-loader`: replace with `exposure: "deferred"` + `tool_search`. Initially kept a cache-safety gate; the user approved removing it so Grok and opencode-go can use web and other deferred tools (section 15).
3. `cost-report`: keep counting old subagent tool-result cost as ordinary tool-result cost. Subagent-specific buckets and UI are removed.
4. The npm `min-release-age=2` gate blocked 0.99.1 (released Sep 29). The user reviewed the release and approved a one-time override (`npm install --min-release-age=0`). `.npmrc` is unchanged.

## 5. Progress

Slice 1 (drift fixes), done and awaiting the automatic checks:

- Pi pins moved to 0.99.1 (`package.json`, `package-lock.json`).
- `shared/model-effort.ts`: `quick` tier gains `openai`, `openrouter`, `opencode-go` fallbacks; `standard` gains `gpt-6.1-sol` first; `deep` Anthropic IDs fixed.
- `auto-name` and `tool-approval` now request the `quick` tier instead of owning model lists. Behavior changes to review: `auto-name` no longer tries the free OpenRouter `cohere/north-mini-code:free`; the reviewer uses the tier's model for the session's own provider only (shell commands do not go to other providers), and the "Tool review skipped …" notice is gone; `grok` reviewer reasoning is now `medium` (was `low`).
- `review` README matches the `deep` tier.
- `run-summary` counts tool-result usage and no longer reads subagent fields.
- `cost-report` no longer has subagent buckets, table, or fields.

Slice 2 (`streamSimple`), done and awaiting the automatic checks:

- `shared/model-fallback` calls `ctx.modelRegistry.streamSimple()`. `ModelCandidate` is now `{ model, reasoning }`; availability uses `hasConfiguredAuth`. Callers that built their own context (`auto-name`, `handoff`) pass `modelRegistry`.
- `aside` calls `ctx.modelRegistry.streamSimple()` without resolving keys or headers.
- `isolated-session` is unchanged: it builds an `AgentSession` and needs the provider and runtime key.

Compaction routing, done and awaiting the automatic checks:

- New `compaction` extension (README, help entry, context catalog entry). `session_before_compact` runs Pi's `compact()` with the session provider's `quick`-tier model and returns the result; otherwise Pi's default compaction runs.
- Not run against a real compaction yet. Test with `/compact` in a Sol or Astra session after `/reload`.
- `model-fallback` and `aside` no longer call `normalizeContext`; `ModelRegistry.streamSimple` normalizes internally.

Not started: settle boundary and `ui_prompt_*`, annotations and approval, Soul spike, `tool-loader` replacement, `tau/auto`, codemode trial.

## 6. Model decisions (recorded)

- Approval reviewer: same provider as the session only. Uses the `quick` tier entry for that provider.
- `tau/auto` compaction (`direct` requests): the `quick` tier entry for the session's provider. Never crosses providers. Providers with no `quick` entry keep the session model.
- Tier edits applied: `claude-sonnet-5` to `claude-sonnet-5-5` (quick, standard); opencode-go `deepseek-v4.1-flash` ahead of openrouter's; `gpt-5.6-luna` removed from quick; opencode-go `glm-5.3-flash` added to quick after deepseek. Cost-based tier ordering was not chosen.
- Provider failover is out of scope.
- Compaction routing is wanted for Opus, GPT-6.1 Sol, and Astra sessions. Implemented as the `compaction` extension on `session_before_compact` (Pi's `compact()` with the session provider's `quick` model), not as the `tau/auto` virtual model. The virtual model would have pinned the normal-turn model per provider. `tau/auto` is dropped.

## 7. Service tier

- Luna always uses Codex priority. A provider overlay (`registerProvider("openai-codex", { api, streamSimple })`) adds `serviceTier: "priority"` for `gpt-6-luna` and reprices cost at 2.5x. The overlay covers the agent loop and every `ctx.modelRegistry` call, so `model-fallback` and `compaction` needed no change. This is the same technique published Pi fast-mode extensions use. An earlier draft of this plan said the agent loop could not do this; that was wrong.
- Pi's built-in multiplier is 2x (2.5x only for `gpt-5.5`). OpenAI documents Codex Fast mode as 2.5x credits for GPT-6 Astra, Sol, and Luna, so the extension recomputes cost.
- Sonnet priority is not possible: Anthropic Priority Tier requires a capacity commitment, the only request field is `service_tier` (`auto` or `standard_only`), Pi does not send it, and the Anthropic login is OAuth.
- Open: if a personal extension that does the same is loaded, only one overlay can win.
- Untested: the Codex backend accepting `service_tier: "priority"` for Luna, and the overlay on 0.99.1 at runtime. First check: a Luna call should cost 2.5x the base rate.

## 8. Settle boundary (slice 3)

- Done: `silent-command-runner` runs its checks in `agent_before_settle`. A failure appends a `tau:silent-command-runner` custom message and returns `continue: true`, replacing the `followUp` message, `agent_end` handler, chain state, and attention hold events. After a failure it resets its file snapshot, so only files the agent changes afterward trigger another check; an agent that gives up no longer re-triggers the same failure. `attention` lost its hold logic; `tau:attention.hold.*` events are deleted.
- Behavior change: `attention` skips `session_compact` notifications while the agent is mid-run (the settle notification follows). Before, only runs with silent checks configured suppressed them.
- Not done, on purpose: replacing `tau:agent.blocked` with `ui_prompt_start`/`ui_prompt_end`. The native event has no body text, so notifications lose "Waiting for bash command approval" and similar. It also fires for user-started panels, and `/commit` notifies while the agent is idle, which an idle gate would drop. `emitAgentBlocked` stays.

## 9. Tool loader (slice 4)

- Done, requires Pi 0.99: `registerDeferredToolGroup()` now registers tools with `exposure: "deferred"` and a namespace. `tool-loader` shrank to two handlers: keep Pi's `tool_search` active when deferred tools exist, and block it on models that cannot take mid-conversation tool additions. `load_tools`, the pending/applied queue entries, branch restoration, and the `tau:prompt.tools.check` and `tau:deferred-tool-group.request` events are deleted. Soul's tool check moved into `shared/tool-changes.ts` next to the new `supportsToolAdditions`.
- The initial gate blocked `grok-4.7` and the opencode-go models. It is now removed (section 15): all models can load deferred tools, accepting cache invalidation where necessary.
- Annotations added to the deferred groups' tools: `web` (read-only, open world), `appshot` (read-only, local; `activate_app` non-destructive), `image_gen` (non-destructive, open world).
- Skipped: annotation-based approval for non-shell tools and `outputSchema` on `explore`/`patch`. Approval has no consumer until an MCP server or third-party tool is configured (there is no `mcp.json`), and `outputSchema` only matters to codemode scripts. Decide both after the codemode trial.

## 10. Validation on Pi 0.99.1

- `codex-priority`: verified. Four Luna turns cost exactly 2.5x the catalog base rate, and the cache-diagnostics log lists `service_tier` in all four Luna requests but not in Astra or Sonnet requests. The 2.5x is Tau's own repricing, so it proves the request asked for priority, not that the backend served it. The observed speedup is subjective; there is no non-priority Luna sample to compare.
- `compaction`: verified on an Astra session. The compaction entry has `fromHook: true` and cost $0.003138, exactly 2.5x Luna's base for its 10,392 input and 432 output tokens. Astra would have cost about $0.126 for the same tokens.
- Settle boundary: verified. A failing check continued the run without a prompt.
- Tool loader: verified. `tool_search` loaded the `appshot` group mid-session on Sonnet 5.5.
- Not yet verified: carrying file lists across two hook-generated compactions, and live deferred-tool activation on Grok/opencode-go after removing the gate.

## 11. Soul spike (scratch only, no production change)

Method: `/tmp/soul-spike/spike.ts` runs a real `AgentSession` on catalog models with an overlay `streamSimple` that records the resolved transcript of each request, then compares each request's messages to the previous one (exact-prefix check). It ran current Soul and a native candidate (`customPrompt = FIXED_INSTRUCTIONS`, each prompt source as a named `sections` entry, frozen sources captured once per compaction epoch in a custom entry). Scenarios: two unchanged turns, an append-source change, resume, `/tree` back two turns, `compact()`, and one turn after.

| Scenario | Soul, Sonnet 5.5 | Native, Sonnet 5.5 | Soul, Grok 4.7 | Native, Grok 4.7 |
| --- | --- | --- | --- | --- |
| Unchanged turns | prefix kept | prefix kept | prefix kept | prefix kept |
| Append source changes | prefix kept (user-role update) | prefix kept (new `system[agents]` patch) | prefix kept | prefix broken at message 0 |
| Resume | prefix kept, values frozen | same | same | same |
| `/tree` to an earlier reply | prefix kept | prefix kept | prefix kept | broken (the branch re-applies the patch) |
| Frozen value | held until compaction | held until compaction | same | same |
| After compaction | new head, value refreshed | head rebuilt with earlier patches folded in, `system[stamp]` patch carries the new value | same as Soul on Sonnet | same as native on Sonnet |

Findings:

- With `customPrompt` set, Pi's section set is `preamble`, `addendum`, `project_context`, `skills`, `cwd` plus custom sections. The default `tools`, `rules` and `docs` sections disappear, so the candidate must supply tool guidance itself.
- Unchanged sections produce no patch across turns, resume and `/tree`. Pi diffs against the system message replayed from the transcript.
- Anthropic and Responses serializers send a patch as an appended `system` message. Models without `supportsMidConvoSystemMessages` (`grok-4.7`, opencode-go) get every patch collapsed into the head, so any post-start section change costs one full-prefix cache miss on those models. Soul avoids this because its updates are user-role messages.
- Only `silent-command-runner` registers an `append` source. Other changes come from the active tool set and from `/reload` edits to AGENTS.md or skills.
- Not verified: the HTTP body. The spike checks the resolved transcript and the serializer code, not a real request.

Native replacement would lose: Soul's frozen AGENTS.md and skills until compaction (native applies `/reload` edits as a patch), the checkpoint-hash guard against another extension rewriting history, and the `context_with_system` tool backstop. It would remove about 450 lines (`soul/`) plus the `tau:prompt.snapshot` plumbing. Decision: replace (see section 12).

## 12. Soul replaced with Pi's native prompt sections

Decisions: verify with a real Luna request first, then replace; apply AGENTS.md and skill edits on the next turn after `/reload`; keep tool guidance as a section and drop the tool list.

- Real-request check (`/tmp/soul-spike/real.ts`, `openai-codex/gpt-6-luna`, real login, temp project): the wire body keeps `instructions`, `tools` and `prompt_cache_key` byte-identical across four turns, and the section patch goes out as an appended `developer` item. Cache reads were 6,656 of about 7,700 tokens on turns 2 to 4 in the first run, including the patch turn. With the new Soul, turns 3 and 4 read 7,680 and turn 2 read 0 with an identical prefix, which I read as Codex not having the cache ready after 4 seconds.
- `soul/index.ts` is now one `before_agent_start` handler: `customPrompt = FIXED_INSTRUCTIONS`, one named section each for documentation, tool guidance and each prompt source, and a `tau.soul.capture` custom entry holding the values of `refresh: "compaction"` sources for the current compaction epoch. Deleted: `soul/context.ts`, `soul/state.ts`, `shared/tool-changes.ts` (its one remaining function moved into `tool-loader`), the `context_with_system` handler, the checkpoint-hash guard and the `PromptValue` type.
- Behavior differences: edited AGENTS.md and skills apply on the next turn; an active-tool change patches the tool-guidance section; on models without mid-conversation system message support (`grok-4.7`, opencode-go) a section change costs one full-prefix miss; a `systemPrompt` returned from another extension's `before_agent_start` is no longer rejected.
- `tau:prompt.snapshot` is now emitted once per turn from `before_agent_start` (it was once per request), so `system-prompt-viewer` adds one snapshot per turn.

## 13. Codemode trial: Luna, read-only Explore tasks

Harness: `docs/plans/pi-0.99-codemode-trial.mjs`; raw results: `docs/plans/pi-0.99-codemode-results.json`. Run with `node --experimental-strip-types docs/plans/pi-0.99-codemode-trial.mjs` from the repo. The harness uses Pi's extension loader for Tau's TypeScript extensions, an isolated agent directory, and in-memory sessions. It does not change user or project settings.

Compared `openai-codex/gpt-6-luna`, reasoning medium, with Tau's priority overlay, Soul and Explore in both profiles. Direct profile exposes read and Explore tools. Codemode profile adds Pi's native codemode in `on` mode; script access to models/classifiers is disabled. Both exclude shell and mutation tools, skills, unrelated extensions and cache warming. Three tasks, repeated twice with profile order reversed: parallel outlines, filtering function declarations across three files, and comparing internal imports across three files. Each trial starts a fresh session.

| Metric, six runs per profile | Direct | Codemode enabled |
| --- | --- | --- |
| Provider requests | 12 | 12 |
| Input tokens, including cache reads | 65,468 | 92,034 |
| Output tokens | 1,404 | 1,408 |
| Measured priority cost | $0.009367 | $0.012097 |
| Runs actually using codemode | 0 | 1 |

All requests asked for priority. All runs finished without tool errors. Codemode was declared in all six enabled runs, but Luna chose direct Explore calls in five. The remaining run used one codemode call with three nested deps calls, with parent tool-call IDs present. Direct parallel calls already completed these tasks in one tool round, so codemode saved no requests. Enabling it increased input tokens by 40.6% and measured cost by 29.1%; cache-hit timing varied, so cost is not a controlled estimate of steady-state overhead.

Answer inspection: outline and dependency answers agreed across profiles. Declaration-filter answers varied: one codemode answer listed matches and then incorrectly claimed there were no matches; one direct answer included compareFingerprints, which does not contain lowercase `fingerprint`. No formal correctness score is assigned.

Recommendation: leave codemode off by default for now. These tasks do not demonstrate a benefit. This is not evidence against scripts that reduce large results or perform dependent calls: that requires a targeted trial encouraging actual script use. No production setting changed. No outputSchema migration or non-shell approval expansion is justified by this trial alone. Nested shell approval and Sonnet behavior remain unverified.

Compaction inspection after the user's reload/compact: the latest two saved compactions in session `01a0ef77-88e6-769f-ab35-c2ba00c900df` retained all previous read-file entries (3 then 8), but both entries have `fromHook: false` and no modified files. This validates only native carry-forward, not Tau's custom-hook fix. A pair of hook-generated compactions is still needed to verify that fix.

## 14. Codemode encouraged: matched repository investigation

User-approved task: investigate every extension's side-call entry points, trace model selection and request paths, classify provider behavior, and cite files and declarations efficiently. Both sessions got the same prompt; only the codemode session added: "Prefer codemode when it helps you complete this investigation efficiently."

Harness: `docs/plans/pi-0.99-codemode-investigation.mjs`; answers, calls and full transcripts: `docs/plans/pi-0.99-codemode-investigation-results.json`. Run with `node --experimental-strip-types docs/plans/pi-0.99-codemode-investigation.mjs`. Same Luna priority/medium, Soul, Explore and isolation as section 13, with read, grep, find and ls exposed in both profiles. One fresh session per profile, direct first. Codemode uses `on` mode with model/classifier access disabled. Shell/mutation tools are excluded. No production setting changed.

| Metric | Direct | Codemode encouraged |
| --- | --- | --- |
| Provider requests | 8 | 8 |
| Input tokens, including cache reads | 93,783 | 157,215 |
| Output tokens | 1,674 | 1,068 |
| Total tokens, input plus output | 95,457 | 158,283 |
| Measured priority cost | $0.009756 | $0.011954 |
| Elapsed seconds | 31.4 | 26.9 |
| Tool calls, including nested | 25 | 21 |
| Codemode scripts | 0 | 3 |

All requests asked for priority. Both sessions stopped normally without tool-result errors. Codemode increased total tokens by 65.8% and measured cost by 22.5%, with no request reduction. Elapsed time is one sample and cannot establish a speed advantage.

The codemode scripts batched discovery and reads but did not filter the results. One script read ten guessed paths (including nonexistent files), printed their raw contents, and produced about 40,276 visible characters with a truncation warning. Later requests continued carrying that output. The direct session generally used narrower reads. Thus, the additional description tokens were not the only overhead: the codemode strategy also admitted more intermediate text to the conversation.

Answer check against source: direct covered eight extension families (aside, auto-name, commit, compaction, tool-approval, handoff, review and image-gen), although it incorrectly introduced the table as six. Codemode covered the first six and omitted review's isolated-session route and image-gen's separate provider/auth route. The direct answer's classifications for those extra paths match `runReview` / `resolveIsolatedSessionModel` and `providerCandidates` / `resolveProviderAuth`. Neither answer explained that the compaction hook returns control to Pi's default compaction when no candidate works; their different-model statements describe only the successful hook path. This was a focused source audit, not a formal exhaustive correctness score.

Conclusion: encouraging codemode alone did not help on this investigation. Keep it off by default for Tau's current landscape. This single pair does not rule out a better script strategy or another model benefiting from result filtering; it measures the requested natural investigation with minimal extra instruction, not an optimized hand-written script.

## 15. Deferred tool access takes priority over cache protection

The user needs Grok and opencode-go to perform web searches and approved removing the tool-search gate. Deleted `supportsToolAdditions` and the `tool_call` blocking handler from tool-loader. The extension now only activates Pi's built-in tool_search when deferred tools exist, or warns when that built-in extension is disabled. README, help and context catalog reflect access on all models.

Cache impact: activating tools can change the final serialized tool declarations and, on models without mid-conversation patch support, the leading prompt/checkpoint. This intentionally invalidates the prefix when necessary to make the tools usable. Pi still owns transcript-backed activation; unchanged loadouts retain their existing request content, and models supporting tool additions keep the native cache-preserving path. Soul's active-tool guidance can also change after activation. No mutable per-turn metadata was introduced.

Requires `/reload`. Live Grok/opencode-go activation remains to be checked after reload; the old blocked-search validation is obsolete.
