# Soul implementation proposal

Read this after `soul-prompt-assembly.md`. This is the implementation shape for approval, not implemented code. Names inside pseudocode describe proposed functions unless identified as existing APIs.

## 1. The whole flow

```text
Extensions supply named pieces of context
                 ↓
Soul combines them with the fixed prompt draft
                 ↓
Save the exact baseline in the session
                 ↓
Every request: replay that baseline and any saved updates
                 ↓
Pi serializes the messages and tool declarations

Successful compaction → capture a fresh baseline
```

Soul owns prompt text. Extensions own their facts. Pi owns tools and provider conversion. There is no overseer.

Replace the prompt in `context_with_system`, which runs before each model call. Do not use `forceSystemPrompt`: the installed Pi implementation collapses system messages and moves current tools to the front, defeating its cache-preserving tool history.

## 2. Extensions supply values, not prompt mutations

One small shared module provides registration and collection. Reuse Tau's event request/response pattern from `src/tool-loading/index.ts`; module-local registries do not work across Pi's isolated extension module graphs.

```typescript
type PromptSource = {
  key: string;
  section: string;
  refresh: "compaction" | "append";
  read(ctx: ExtensionContext): Promise<string>;
};

registerPromptSource(pi, source): void
  subscribe to "tau:prompt.sources" using onTauEventImmediately
  when asked, call request.accept(source)

collectPromptSources(pi): PromptSource[]
  emit "tau:prompt.sources" with accept(source)
  collect sources; reject duplicate keys; sort by section order, then key
```

Readers return the complete current value. They do not add XML wrappers or mutate a shared prompt. Soul adds the tags and section layout.

| Source | Read when |
| --- | --- |
| Date and directory listing | First capture and successful compaction |
| Documentation guidance | First capture and successful compaction |
| Subagent availability | Each request; append only when changed |
| Automatic-check instructions | Each request; append only when changed |
| Approval instructions | Each request; append only when changed |

Pi already supplies skills, project files, user prompt additions, tool descriptions, and tool guidance through `BuildSystemPromptOptions`. Copy those inputs in `before_agent_start`. Use them when building a baseline; do not reread their files on every call. Tool activations carry their newly relevant guidance in the appended update path.

The environment reader captures date and listing together. Midnight alone does not invoke it.

## 3. Save text once and replay it

Use custom session entries for a baseline and its later updates. The session entry IDs identify their branch positions. No separate database or cache service.

```typescript
type SourceValue = {
  key: string;
  section: string;
  text: string;
};

type SavedBaseline = {
  boundary: { kind: "initial" } | { kind: "compaction"; entryId: string };
  text: string;
  values: SourceValue[];
  initialTools: ToolDeclaration[]; // Pi's declarations at this boundary
};

type SavedUpdate = {
  baselineEntryId: string;
  afterEntryId: string;
  text: string;
  values: SourceValue[];
};

type RestoredPrompt =
  | { kind: "capture"; boundary: SavedBaseline["boundary"] }
  | { kind: "active"; baselineEntryId: string;
      baseline: SavedBaseline; updates: SavedUpdate[] };
```

`restorePrompt(branch)` finds the latest baseline on the selected branch and replays its updates. If a successful compaction is newer than that baseline, it returns `capture`. This also covers resume after compaction. Failed compaction creates no new boundary.

Reload, resume, fork, and tree navigation restore the branch's saved text. They do not recalculate its date or silently install new instructions.

## 4. One path before each request

```typescript
before_agent_start(event):
  resourceInputs = copyRelevantInputs(event.systemPromptOptions)
  // No systemPrompt return value. No forceSystemPrompt.

context_with_system(event, ctx):
  branch = ctx.sessionManager.getBranch()
  state = restorePrompt(branch)
  sources = collectPromptSources(pi)

  if state.kind == "capture":
    values = await readAll(sources, ctx)
    baseline = {
      boundary: state.boundary,
      text: renderBaseline(FIXED_INSTRUCTIONS, resourceInputs, values),
      values,
      initialTools: Pi's current tool declarations
    }
    persistBaseline(baseline)
  else:
    previous = replayValues(state.baseline.values, state.updates)
    current = await readAppendSources(sources, ctx)
    changed = compareByKeyAndExactText(previous, current)

    if changed is not empty:
      persistUpdate({
        baselineEntryId: state.baselineEntryId,
        afterEntryId: last projected conversation entry ID,
        text: renderUpdate(changed),
        values: changed
      })

  saved = restorePrompt(ctx.sessionManager.getBranch())
  return { messages: projectRequest(event.messages, saved, ctx) }
```

`persistBaseline` and `persistUpdate` use `pi.appendEntry`. Read the saved branch again so projection includes the records just written. Persist before sending; a retry sees the saved values and does not create the same update twice.

If a reader fails, do not persist a partial capture or mistake failure for an empty value. Report the source and abort the request through `ctx.abort()`. Do not rely on throwing alone: Pi catches extension-handler errors. An empty successful value explicitly clears that source through an appended notice.

## 5. One example, end to end

The subagent extension keeps its existing discovery and visibility logic. It replaces its prompt-append handler with a source:

```typescript
registerPromptSource(pi, {
  key: "subagent/availability",
  section: "subagents",
  refresh: "append",
  read: async ctx => formatAvailableAgents(await parentVisibleAgents(ctx))
})
```

```text
First request
  read → "Available agents: context-sync, web-research"
  save that value inside the baseline

Next request, unchanged
  read → same value
  send the same baseline; write nothing

User disables web-research
  read → "Available agents: context-sync"
  save an update after the current conversation entry:
    <context-update source="subagent/availability">
    This replaces the previous availability information for this source.
    Available agents: context-sync
    </context-update>
  send the original baseline plus this new message

Following request
  replay the same update at the same position

Successful compaction
  read current availability
  save a new baseline containing only context-sync
  old updates no longer need separate replay
```

The disabled agent remains disabled in the executor immediately. Prompt snapshots never freeze safety or availability enforcement.

## 6. Build the messages without moving history

```typescript
projectRequest(messages, saved, ctx):
  replace the leading prompt text with saved.baseline.text
  use saved.baseline.initialTools at that head
  remove Pi-generated prompt-section text from later patches
  keep later tool declarations at their existing positions
  insert each saved update after its recorded entry
  leave conversation messages unchanged
```

Use `ctx.sessionManager.buildSessionProjection().entries`: each entry supplies `sourceEntry.id` and its projected messages. Place an update after the entire message group belonging to its anchor. Do not use timestamps or save array indexes. An anchor mismatch is a request error, not permission to move an old update to the end.

Render updates as durable ordinary context messages. This keeps them in the conversation on models that would otherwise fold later system instructions into the leading prompt. Use the same role and exact text on every replay.

Retain tool-only system messages: Pi needs them for native tool additions. Remove only the prompt-section patches being replaced by Soul, not arbitrary external instructions.

All Tau whole-prompt append handlers migrate together. User `SYSTEM.md` and appended instructions remain tagged contributions. A third-party forced prompt conflicts with this delivery path; report the conflict rather than silently overwrite it or claim cache stability.

## 7. Tools use Pi's existing transport

Do not build a second provider serializer. Pi already anchors additions for compatible models:

- Anthropic uses deferred declarations and mid-conversation `tool_addition` blocks.
- OpenAI Responses uses `additional_tools` or client tool-search messages.

Both have fallback paths that rebuild leading tool lists. Same-name schema changes are not safe additions; OpenAI removals also trigger fallback.

```typescript
type ToolChangeDecision =
  | { kind: "allow" }
  | { kind: "requires-compaction"; reason: string };

admitToolChange(model, admittedHistory, requestedDeclarations): ToolChangeDecision
  unchanged declarations → allow
  compatible native addition of new names → allow
  anything that rewrites the leading declarations → requires-compaction

load_tools.execute(request):
  requested = resolveAllowedGroupTools(request)
  decision = admitToolChange(model, history, requested)
  if requires-compaction: return the reason without changing active tools
  pi.setActiveTools(requested)
  append newly relevant tool guidance through Soul
```

Use actual model compatibility flags, not provider-name guesses. Apply the same rule to reload-driven declaration changes. Retain disabled declarations until compaction while rejecting their execution immediately. Do not silently compact to make a change pass.

This check is shared by tool-loading and the request boundary: checking only `load_tools` would miss loadout changes from reload or other extensions. At the request boundary, abort an incompatible change rather than send a prefix-breaking fallback.

## 8. Files and implementation order

Paths below are relative to `packages/agent`.

| Slice | Changes that ship together |
| --- | --- |
| 1. Remove overseer | Delete `extensions/soul/overseer.ts` and its registration; delete overseer-only `settings.ts`; remove feature/settings docs from Soul and Tau help; let schema sync regenerate the schema |
| 2. Replace prompt assembly | Update `soul/prompt.ts` from the draft; add `shared/prompt-contributions.ts`; wire collection and rendering in `soul/context.ts`; wire persistence/projection in `soul/state.ts` and hooks in `soul/index.ts`; migrate existing contributors and tool-change admission together |
| 3. Verify and document | Update prompt viewer and cache diagnostics where needed; verify final payloads; update affected extension docs and context ownership |

The second slice is one coherent integration: shipping it with old whole-prompt append handlers would defeat the design. The new modules separate shared registration, rendering, and session replay; there is no general state framework or provider-specific prompt system.

Migrate `runtime-context`, Explore guidance, `tau-help`, subagent guidance, `silent-command-runner`, and `tool-approval`. Reuse their existing readers and formatting. Keep tool metadata owned by tool registrations. Remove obsolete concatenation code in the same change.

Delete all overseer model calls, review markers, nudges, and configuration references. Do not replace them or rewrite historical session files. Refresh `.pi/contexts/01_extensions/soul.toml` through context synchronization after implementation.

## 9. Approval and proof

This proposal approves one shared source boundary, persisted prompt generations, append-only operational updates, `context_with_system` delivery, and compaction-required results for incompatible tool changes.

After `/reload`, use existing diagnostics to inspect final Anthropic and OpenAI requests. Walk the example above, load a tool, cross a date boundary, reload/resume, and compact. Confirm old text and initial declarations stay fixed; updates retain their positions; only successful compaction replaces the baseline. Include automatic compaction followed immediately by a retry.

Compare provider payloads, not just `ctx.getSystemPrompt()` or cache-hit counts. The prompt viewer must display Soul's projected baseline and updates rather than Pi's unprojected default. No new tests or test-only injection layer.

## Implementation references

- Tau event registry pattern: `src/tool-loading/index.ts`
- Pi request hooks: `pi-coding-agent/dist/core/agent-session.js` and `dist/core/extensions/runner.js`
- Public entry/message mapping: `pi-coding-agent/dist/core/session-manager.d.ts`
- Provider replay and fallbacks: `pi-ai/dist/utils/transcript.js`, `dist/api/anthropic-messages.js`, `dist/api/openai-responses.js`, `dist/api/openai-responses-shared.js`

Dependency paths above are under `node_modules/@earendil-works/`.
