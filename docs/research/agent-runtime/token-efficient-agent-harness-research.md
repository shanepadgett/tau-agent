# Token-efficient agent harness research

Status: planning/research. No product extension scaffolded. No final name.

This is the canonical post-compaction handoff. Trust this over fuzzy chat summaries. Read this first after compaction. Do **not** reread giant Pi/crumbs/hashline/VCC docs unless an exact API/detail is missing. Do **not** implement product code until name/scope are confirmed and posture switches to act.

## 0. Current direction

Build a full token/turn/cost-efficient agent harness, likely prototyped as Tau/Pi extension(s). User explicitly wants the larger harness, not just a minimum file-edit tool. Build in stages, but preserve the full operating-system-shaped vision.

Goal: stop wasting enterprise money/context on agent loops by managing state, context, tools, validation, and edits as one system.

Core pieces:

- durable agent runtime state/event log
- deterministic compiled context view for each turn
- managed file/search/context capsules
- exact hidden handles for recoverable detail
- batch filesystem mutation
- policy-gated search/read/context packs
- quiet validators
- RTK-style tool-output compression lane
- controlled Python/Node probes
- LSP/code-intelligence operations
- no-bash/low-bash normal mode
- prompt-cache-aware stable prefix + late runtime capsules
- deterministic VCC/pi-vcc/pi-mrc-style compaction
- prompt-intake metadata classifier experiment
- token-friendly JSON/tool-output projections
- reports with dollar/token math

Working product wording:

> The harness maintains durable agent runtime state and derives a deterministic, prompt-cache-aware compiled context view for each turn. Tool outputs are retained as addressable records/artifacts and projected into context only through compact handles, summaries, or exact lookups.

Avoid using bare `RTK` for the whole architecture. In AI coding-agent tooling, RTK mostly means Rust Token Killer / tool-output compression.

Names floated, not chosen: `anchored-files`, `batch-fs`, `file-surgeon`, `hash-fs`, `fileflow`.

## 1. Why this changed from file tools to harness

Original request: design a better Tau extension for filesystem reads/mutations, informed by crumbs `apply_patch` and `pi-hashline-readmap`, before scaffolding.

Research expanded because edit syntax alone cannot fix the waste:

- exact-text edits repeat old text and fail on drift
- patch formats still require context/old lines and retries
- search/read exploration burns whole model turns
- raw tool outputs persist as stale context
- passing validators dump useless logs
- bash is noisy, unsafe, and unstructured
- posture/tool/prompt changes can bust prompt caches
- subagents often summarize prose then parent rereads

The real question now:

> Can a harness maintain compact current truth well enough that the model stops paying rent on stale evidence?

File tools are one consumer of that state. Search, validators, LSP, probes, subagents, and compaction are others.

## 2. Decisions and current bets

### Strong decisions

- Optimize total task cost, not isolated tool-call payload size.
- Extra model turns are expensive even with prompt caching.
- Provider context should contain current compact truth, not raw historical evidence.
- Raw transcript/UI/debug may retain everything; provider context gets projections/capsules.
- Deterministic compaction/projection should be default; model summarization is fallback.
- Hidden handles are strongest edit-addressing candidate; visible hashes are baseline/fallback.
- A handle/ref is not evidence. Expand/lookup before relying on hidden exact content.
- Repository source should usually be stored as locator + digest/symbol/range, not stale copied source body.
- Batch mutation should return refreshed file capsules; no manual reread loop.
- Search/list/read need owned/vendor/generated policy.
- Quiet validators should hide passes and expose compact failure capsules only.
- Bash should not be normal mode; typed tools and probes cover common work.
- LSP is first-class for semantic operations. Working line: **grep finds strings; LSP finds meaning.**
- Prompt/cache layout matters: stable prefix, dynamic late runtime/capsule suffix.
- Tool schema changes may bust cache; measure stable schemas + gates vs mode-specific schemas.
- Subagents are suspect unless they return typed context patches/capsule deltas.
- Reports must include dollar math, not only tokens.

### High-confidence bets

- Passing validator logs should not enter model context.
- Stable prompt prefix + late dynamic runtime/capsule block will beat rewriting system prompts.
- Batch mutation beats repeated exact edits for multi-edit tasks.
- Whole small owned files often beat another discovery turn.
- Upfront scoped context can beat naive iterative discovery even when final useful context is identical.
- RTK-style command/tool-output compression is useful, but it is a lane, not the architecture.

### Medium-confidence bets

- Hidden handles beat visible hashlines for normal managed sessions.
- Context packs/repo maps beat blind exploration when scope precision is good.
- LSP wins semantic refactors enough to justify first-class support.
- Tuple/columnar output matters for large result tables.
- Prompt-intake side classifier can improve compaction/alignment if user-confirmed on risky labels.

### Needs proof / unresolved

- Exact product split: one extension vs coordinated suite.
- Final name.
- Hidden handle durability across compaction/posture/process restart.
- Safe relocation after stale handles; V1 should probably fail tight before relocating.
- Multi-file transaction semantics: partial vs all-or-nothing.
- Tool schema caching behavior per provider.
- Whether mode-specific tool exposure is worth cache churn.
- Scope/context-pack thresholds for large repos.
- Subagent typed patches vs deterministic scout.
- Prompt-intake classifier false positives, especially durable preferences.
- Generic JSON compaction model readability vs retry rate.
- No-bash coverage of real coding tasks.
- LSP cold-start/index cost.

### Anti-goals

- Giant permanent system prompt.
- Dump raw output then hope pruning fixes it later.
- Model compaction as default.
- Fuzzy recall when exact handles exist.
- Auto-reading vendor/generated/dist/coverage/snapshots by default.
- Hiding unresolved failures/security/data-loss risk.
- Tuple/DSL syntax so cryptic it causes retries.
- Text edits for semantic refactors where LSP can safely do it.
- Bash as default exploration/mutation path.
- Framework cosplay: factories/interfaces/config for one implementation.

## 3. Cost model

Optimize:

```text
total =
  model turns
+ input context each turn
+ tool input/output
+ visible output kept alive across future turns
+ retries
+ validation loops
+ prompt/tool schema rent
+ cache invalidation
+ correctness/security risk
```

Important terms:

- `visible_tokens`: provider-visible context/tool output
- `hidden_bytes`: stored details not sent to model
- `future_lifetime_tokens`: retained visible output x future turns
- `effective_input_cost`: uncached + cached * cache ratio
- `retry_expected_cost`: retry probability x retry turn/tool/context cost
- `waste_multiplier`: realistic discovery context / useful target context

Whole-read intuition:

```text
file_tokens < expected_extra_turns_saved * effective_turn_cost
```

If current context is 80k and cached input costs 10%, one extra turn still costs about 8k effective input tokens before tool output/output tokens. Reading a 5k-token owned file can be cheaper than one avoided turn.

Context-pack intuition:

```text
upfront_pack = one 40k true-context hit
iterative_discovery = N turns + grep/list/find/search noise + same 40k reads + irrelevant reads
```

Final context being equal is not equal cost.

## 4. Architecture

### 4.1 Agent runtime state -> compiled context view

Use a compiler model:

```text
raw event/state log
  -> normalize/filter noise
  -> typed IR
  -> deterministic capsule/view projection
  -> compact provider context
  -> exact lookup/expand handles for hidden detail
```

State types:

- user/assistant turns
- tool calls/results
- file reads/writes/searches
- validator/probe/LSP results
- decisions/preferences/scope changes
- subagent outputs
- compactions/projections

Provider context should contain at most current useful projections:

- current objective/scope
- active constraints/preferences
- current file capsules
- relevant search capsules
- unresolved validator/security/data-loss failures
- decisions and open questions
- late runtime capsule: posture/mode/tool policy/continuation/validator state

Raw state/UI can retain exact details. Provider context should not carry stale duplicate reads/logs.

Capsule metadata:

```text
id, type, createdTurn, updatedTurn, paths, digest/revision,
state, pinned, supersededBy, coveredBy, resolvedBy,
visibleSize, hiddenRef
```

States: `active`, `pinned`, `covered`, `superseded`, `stale`, `hidden`, `resolved`, `failed`.

Safety:

- Never prune user requirements.
- Never hide unresolved failures without compact visible diagnostics.
- Never hide uncertainty that affects correctness; summarize it.
- Hide raw evidence only when current capsule/decision preserves the useful fact.

### 4.2 VCC / pi-vcc / pi-mrc lessons

References read:

- `/Users/shanepadgett/.local/share/tau-agent/references/VCC/README.md`
- `/Users/shanepadgett/.local/share/tau-agent/references/pi-vcc/README.md`
- `/Users/shanepadgett/.local/share/tau-agent/references/pi-vcc/src/core/summarize.ts`
- `/Users/shanepadgett/.local/share/tau-agent/references/pi-vcc/src/core/build-sections.ts`
- `/Users/shanepadgett/.local/share/tau-agent/references/pi-vcc/src/core/search-entries.ts`
- `/Users/shanepadgett/.local/share/tau-agent/references/pi-vcc/src/hooks/before-compact.ts`
- `/Users/shanepadgett/.local/share/tau-agent/references/pi-model-reference-compactor/README.md`
- `/Users/shanepadgett/.local/share/tau-agent/references/pi-model-reference-compactor/src/strategies/model-reference.ts`
- `/Users/shanepadgett/.local/share/tau-agent/references/pi-model-reference-compactor/src/core/mrc-reference-journal.ts`

VCC: raw JSONL is source of truth; views are computed on demand; block roles and pointers beat grep; shared coordinates let compact views expand exact detail. This is projection, not memory magic.

pi-vcc: no-model compaction can produce useful state in milliseconds. Pipeline: normalize -> filter noise -> cut -> extract sections -> brief transcript -> format -> merge. Sections: Session Goal, Files/Changes, Commits, Outstanding Context, User Preferences, brief transcript. Merge sticky sections, replace volatile ones, roll transcript. Recall is search -> ranked snippets -> expand exact entries.

pi-mrc: KEEP/REF/DROP; hidden ref bodies; tiny visible anchors; exact `mrc_lookup`; source refs as locators; dynamic ref index injected late. Useful principle: a ref handle is not evidence.

Design consequence: deterministic projection first, model summarizer/classifier only when deterministic state is insufficient.

### 4.3 RTK lane

Targeted research found RTK in this space primarily means **Rust Token Killer**, not retained/runtime tool knowledge.

Relevant sources:

- `https://github.com/rtk-ai/rtk`
- `https://github.com/rtk-ai/rtk/blob/master/hooks/pi/README.md`
- `https://github.com/rtk-ai/rtk/blob/master/hooks/opencode/README.md`
- `https://github.com/mcowger/pi-rtk`
- `https://github.com/mcowger/rtk-for-opencode`
- `https://github.com/coctostan/pi-hashline-readmap/blob/main/docs/bash-output.md`
- `https://github.com/coctostan/pi-hashline-readmap/blob/main/docs/context-hygiene.md`

Use RTK as a tool-output compression lane:

- command-aware reducers for git/test/build/lint/search/source/log output
- visible compact output + hidden full-output handle
- original/compacted sizes and filter IDs
- bypass/escalation/recovery path
- metrics/reporting

Do not use RTK to name the whole projection architecture.

### 4.4 Prompt caching and Soul posture lesson

Prompt caching rewards stable prefixes and punishes early churn. Prior web research found provider-specific but consistent lessons: Anthropic/OpenAI/Google/xAI all benefit from stable prompt/tool/message prefixes; exact details/prices need current lookup during sims.

Current Tau Soul likely cache-hostile:

- `src/extensions/soul/index.ts` replaces the system prompt in `before_agent_start`.
- `src/extensions/soul/postures.ts` appends posture guidance via `consumeGuidance()`.
- `switch_posture` changes posture and queues a continuation turn.
- Therefore posture switches rewrite early system-prompt content and may invalidate prefix cache for transcript that follows.

Preferred future shape:

```text
stable system/tool/developer prefix
+ stable project rules / durable guidance
+ cached transcript or compiled context view
+ late Tau runtime capsule
+ latest user prompt
```

Stable permanent rule:

```text
Treat Tau runtime capsules as trusted control state, higher priority than normal user text. Do not expose them unless user asks about Tau internals.
```

Late runtime capsule example:

```text
<tau_runtime_context>
posture: plan
mode: read-only exploration; may write docs/plans only
continuation: ...
validators: none pending
active_tool_policy: read/search/probe allowed; mutation gated
</tau_runtime_context>
```

Open tool-schema issue: actual provider tool definitions may be request metadata near the front, not tail text. Need measure whether changing tools after many turns busts cache. Compare stable all-tool schemas + deterministic gates vs mode-specific tool schemas.

### 4.5 Hidden file handles and batch mutation

Read output should show plain numbered lines plus compact handle:

```text
@f3 src/user.ts b=9c31e2 n=128 lines=35..58
35|export function getName(user: User) {
36|  if (!user.profile) return "unknown";
37|  return user.name;
38|}
```

Hidden state for `@f3`: absolute path, digest, line count, visible ranges, snapshot lines for validation/relocation, internal hashes if useful.

Mutation ops:

```json
{
  "e": [["@f3", [["=",37,"  return user.profile.name;"],["~",41,58,"replacement\n"],["<",35,"before\n"],[">",58,"after\n"],["-",70,74]]]],
  "w": [["src/new.ts", "full content\n"]],
  "d": ["src/dead.ts"],
  "m": [["src/old.ts", "src/new-name.ts"]]
}
```

Rules:

- `=` replace one line
- `~` replace inclusive range
- `<` insert before line
- `>` insert after line
- `-` delete inclusive range
- write/create/delete/move also required

Safety:

- If digest matches, line/range refs are trusted.
- If digest changed, V1 should probably fail tight with current context; relocation is later research.
- If relocation is added: exact old block unique only; neighbor pair unique only; otherwise fail.
- Hidden state gone + digest changed = fail/reread.
- Hidden state gone + digest matches = line refs can still apply.

Mutation result should update file capsules immediately. For small owned files, return full refreshed capsule; for large files, return changed ranges plus updated previously visible ranges.

### 4.6 Search/read/context packs

`fs_search` should be separate from `fs_read` and should return grouped capsules, not raw `rg` dumps.

Policy buckets:

- owned source/tests/local extensions: auto-read matched ranges or whole small files under threshold
- owned docs/config: lower threshold
- generated/build/minified/dist/coverage/snapshots: no auto-read by default
- vendor/dependencies (`node_modules`, vendor, caches): no auto-read by default; targeted debug mode only
- binary/images: never read as text

Scope/context packs generalize `tau-edit`: user/harness selects files/dirs/resources, then the harness injects relevant owned context before the model wanders. Pack layers:

1. user-selected files/dirs
2. active diff/failing diagnostics/stack traces
3. file tree slice
4. symbol/signature map
5. import closure
6. reverse deps for API changes
7. relevant snippets
8. whole small files under threshold

Need pricing proof for 40k upfront pack vs naive discovery to same context.

### 4.7 `ctx_prune`, `ctx_budget`, and capsule lifecycle

`ctx_prune` updates provider projection while raw transcript remains.

Use after:

- reads cover old search hits
- validator failure fixed and later pass confirms it
- probe/research result becomes a decision
- stale file capsule superseded

`ctx_budget` should report retained capsules and rent:

```text
context 42k visible
@f4 src/foo.ts 3.2k current
@s9 search old API 1.1k covered by @f4/@f8, prunable
@v7 TypeScript failure 0.3k unresolved
```

Could be tool, footer/status widget, or periodic note.

### 4.8 Quiet validators

Model instruction should be tiny:

```text
Do not run validation checks yourself. Changes are validated deterministically; failures will be reported.
```

Mechanics:

- file changes mark validator scopes dirty
- debounce batches
- cancel obsolete runs
- pass stays UI/status-only
- failure injects compact pinned diagnostic capsule
- later pass retires failure silently
- final answer gates on relevant pending/failed validators
- auto-fix formatters must update capsules

Failure capsule:

```text
@v7 TypeScript failed
src/foo.ts:41 TS2322 string not assignable to number
src/bar.ts:9 unused import
```

Claude hooks `asyncRewake`, Aider lint/test loop, and Zed diagnostics support the pattern.

### 4.9 No-bash and controlled code probes

Normal mode should replace bash with typed tools:

- list/find/search/read/apply/write/move/delete
- git status/diff/log compact tools
- validators/diagnostics
- LSP tools
- code_probe
- named tasks/tests only

Bash remains explicit escape hatch or disabled by policy. Shell is a security boundary problem: private data + untrusted content + external communication = exfiltration risk.

`code_probe` is not bash renamed. It is a deterministic lab:

- `simulate`: math/token/schema experiments
- `inspect`: parse declared files and report
- `preview`: produce diff, no write
- `apply`: later, only through mutation pipeline

Constraints: no network by default, minimal env/no secrets, declared read/write globs, time/memory/output caps, hidden full logs + compact capsule.

### 4.10 LSP/code intelligence

Grep finds strings; LSP finds meaning.

TypeScript route: `typescript-language-server --stdio`, `vscode-languageserver-protocol`, possibly tsserver commands for refactors/organize imports.

Tools to test:

- rename symbol
- find refs
- go to definition
- hover/signature/type info
- diagnostics
- organize imports

LSP wins likely: semantic rename, refs, diagnostics, imports. LSP loses likely: tiny one-file text edits, cold start, broken project config, generated/dynamic code.

### 4.11 Prompt/context rent

Prompt text is rent. Keep permanent kernel small:

```text
Use YAGNI. Prefer the smallest clear correct change.
```

Use mode/tool/scope shards only when needed. Tool errors can carry edge-case guidance instead of permanent prompt bloat. Cache layout should avoid dynamic timestamps/random IDs early.

### 4.12 Subagents and deterministic scouts

Preferred first test: deterministic scout/search pack, not model subagent.

Subagents may win when discovery is broad/noisy and result patch is tiny. They likely lose when they return prose summaries that force parent rereads.

Good subagent/scout output is a typed patch:

```json
{
  "add_context": [{"path":"src/auth.ts","ranges":[[40,90]],"reason":"defines token validation"}],
  "drop": ["@s3"],
  "open_questions": ["confirm middleware order"]
}
```

### 4.13 Prompt-intake classifier

Open idea: after each user prompt, run a tiny cheap classifier over that prompt only while the main agent works. It extracts metadata outside provider context for later deterministic compaction/alignment.

Labels: new goal, same-goal refinement, scope change, correction/feedback, durable preference, temporary instruction, blocker, decision/approval, reversal, topic handoff, clarification needed.

If low-confidence/high-impact, show tiny user menu: persist preference? mark new goal? old goal resolved? User-confirmed flags outrank inferred flags.

Risk: false durable preferences and annoying prompts. Sim before productizing.

### 4.14 JSON/tool-output format conversion

Open idea: deterministic converter from arbitrary JSON-like payloads to token-friendly visible formats.

Candidates:

- tuple rows + schema/legend
- `{ "cols": [...], "rows": [...] }`
- path-delta rows for nested structures
- intern/dictionary tables for repeated strings/paths/statuses
- JSON Lines with header schema
- compact projection + hidden raw JSON handle

Lossless mode keeps raw JSON hidden and visible rows expandable. Lossy mode must declare dropped fields/counts/truncation. Measure model errors; ultra-compact formats can lose through retries.

## 5. Reference baselines

### Crumbs `codex-compat/apply_patch`

Read paths: `/Users/shanepadgett/.local/share/tau-agent/references/crumbs/extensions/codex-compat/README.md`, `index.ts`, `src/apply-patch.ts`, `src/patch-parser.ts`, `src/patch-executor.ts`, `src/patch-matcher.ts`, `src/path-policy.ts`, parser/executor tests.

Lessons:

- one-call multi-file patch is table stakes
- grammar supports add/replace/update/delete/move
- sorted nested `withFileMutationQueue` avoids races/deadlocks
- forgiving matching helps but can hit wrong duplicate context
- multi-file patches are not atomic in that reference
- patch repeats old/context text and does not solve context lifetime

### `pi-hashline-readmap`

Read paths: `/Users/shanepadgett/.local/share/tau-agent/references/pi-hashline-readmap/README.md`, prompts, `index.ts`, `src/hashline.ts`, `src/read.ts`, `src/edit.ts`, `src/write.ts`.

Lessons:

- visible `LINE:HASH|content` gives stale anchors but taxes every read line
- `HASH_LEN = 3`, whitespace-stripped `xxhash-wasm` h32
- edit uses anchored ops, session read guard `file-not-read`, mutation queue, optional verify
- relocation/hash index/fuzzy token similarity exists; useful but risky
- structural maps/symbol reads are useful but probably belong to LSP/semantic tools first
- context hygiene/read freshness is directly relevant

### Web-research baselines

- Aider is serious baseline: edit-format benchmark data, repo map, SEARCH/REPLACE vs diff/whole-file tradeoffs.
- Codex/OpenAI/Cline/OpenHands/SWE-agent orbit `apply_patch`/diff.
- Claude exact `old_string` edit shows hidden read-before-edit state and stale/unique checks.
- OpenAI Apps SDK `_meta`, OpenAI compaction, LangGraph state, Claude compaction/subagents support provider context != raw transcript/UI.
- Prompt caching favors stable prefix + dynamic suffix.
- Quiet validators supported by Claude hooks/Aider/Zed patterns.
- Scope packs/repo maps: Aider repo map, Continue context providers, Cursor/Claude `@file`, Repomix, Cody/Sourcegraph.

## 6. Research scripts and reports

All scripts under `docs/research/agent-runtime/`. Reports under `docs/research/agent-runtime/runs/` as Markdown + CSV/JSON.

Common row:

```text
scenario, policy, turns, visible_tokens, hidden_bytes, tool_input_tokens,
tool_output_tokens, retry_expected_cost, effective_cost, dollars, winner, why
```

Use rough token estimate chars/3.5-4 first. Add real tokenizer only if already available; no new dependency just to estimate.

Recommended order:

1. `repo-size-profile.py` — real repo file sizes/buckets before guessing thresholds.
2. `context-pack-pricing-sim.py` — 40k upfront scoped pack vs naive discovery to same context.
3. `turn-cost-sim.py` — whole-read small owned files vs extra exploration turns.
4. `cache-layout-sim.py` — stable prompt prefix, late runtime capsules, posture/tool changes.
5. `projection-compaction-sim.py` — deterministic VCC/pi-vcc projection vs model compaction/raw transcript.
6. `encoding-size-sim.py` — hidden handles/hashline/apply_patch/exact/whole write/LSP command.
7. `schema-shape-sim.py` + `json-payload-format-sim.py` — tuple/columnar/legend formats.
8. Then `search-policy-sim.py`, `retry-cost-sim.py`, `validator-cost-sim.py`, `rtk-output-compression-sim.py`, `prompt-rent-sim.py`, `prompt-intake-classifier-sim.py`, `subagent-cost-sim.py`, `lsp-vs-edit-sim.py`, `capsule-lifetime-sim.py`, `tool-schema-overhead.md`.

### Sim specs

`repo-size-profile.py`: measure file sizes/line counts by source/docs/config/generated/vendor buckets; thresholds; largest offenders. Feeds pack/search/read sims.

`context-pack-pricing-sim.py`: compare one upfront `40k` true-context injection vs iterative discovery. Parameters: target context `15k/25k/40k/80k`, base context, provider prices/cache ratios, discovery turns `2/4/8/12`, grep/list/find noise, irrelevant read multiplier `1.1x/1.5x/2.5x`, future turns. Output dollar tables and break-even discovery turns.

`turn-cost-sim.py`: whole file vs search+range vs serial exploration vs scope pack. Parameters: context size, cache ratio, file size, avoided turns, future lifetime. Prove small owned whole reads can win.

`cache-layout-sim.py`: stable prefix+dynamic suffix vs system prompt rewrite; late runtime capsule; stable schemas+gates vs changing tool schemas. Include current Soul-like posture switch cost. Need provider-specific behavior research.

`projection-compaction-sim.py`: raw transcript vs model summary vs VCC views vs pi-vcc sections vs pi-mrc KEEP/REF/DROP vs hybrid prompt classifier. Metrics: reduction, runtime, model calls, cache churn, critical-fact retention, exact recall success, false preference carry-forward.

`encoding-size-sim.py`: compare built-in exact edit, crumbs patch, visible hashline, hidden tuple, verbose JSON, compact DSL, whole write, LSP command. Include read+mutation+retry+lifetime cost.

`schema-shape-sim.py`: object rows vs tuple/legend rows. Find break-even row counts.

`json-payload-format-sim.py`: raw/minified JSON vs JSONL vs tuple rows vs columnar rows vs path-delta vs intern tables vs compact projection+hidden raw handle. Measure savings and parse/retry risk.

`search-policy-sim.py`: search only vs auto-read ranges/whole small owned files vs aggressive auto-read vs vendor-blocked. Set thresholds.

`retry-cost-sim.py`: exact edit, patch, visible hashline, hidden handle strict fail, hidden handle relocation. Decide V1 relocation policy.

`validator-cost-sim.py`: manual raw checks vs compact command capsule vs quiet validators. Passing logs hidden; failures compact.

`rtk-output-compression-sim.py`: raw bash/tool output vs truncation vs RTK-style command-aware reducers vs typed compact tool output. Measure hidden-full-output recovery frequency and missed-critical-line risk.

`prompt-rent-sim.py`: giant prompt vs compact kernel+shards vs tool-error guidance.

`prompt-intake-classifier-sim.py`: regex-only vs tiny prompt-only classifier vs classifier+user confirm. Measure metadata precision/recall and annoyance/wrong carry-forward.

`subagent-cost-sim.py`: parent search/read vs deterministic scout vs prose subagent vs typed-patch subagent.

`lsp-vs-edit-sim.py`: TS rename/refs/diagnostics/organize imports; compare grep+model edit, LSP refs+model edit, LSP rename workspace edit. Include cold/warm latency.

`capsule-lifetime-sim.py`: raw accumulation vs auto-replace capsules vs manual prune vs mixed policy.

`tool-schema-overhead.md`: measure tool descriptions/schemas/guidelines and many-small-tools vs grouped tools.

## 7. Fixture cases

Edit/addressing:

1. single-line edit
2. three edits in one file
3. function/range replacement
4. insert before/after
5. append/prepend
6. add file
7. full config rewrite
8. delete file
9. move file
10. move + edit
11. refactor 3 files
12. refactor 10 files
13. small edits across 25 files
14. duplicate identical lines
15. stale read with moved content
16. stale read with duplicate candidates
17. whitespace-sensitive file
18. binary/image rejected

Exploration/context:

19. small owned file full-read beats two searches
20. large owned file search+range beats whole read
21. vendor hit no auto-read
22. owned hit auto-read range
23. scoped 40k pack vs iterative discovery
24. failed exact edit retry
25. 100-line failed check log vs quiet capsule
26. passing validator hidden
27. prose subagent forces reread
28. deterministic scout returns enough
29. LSP rename vs grep/text/codemod
30. tuple/columnar JSON conversion
31. posture switch system rewrite vs late runtime capsule
32. tool schema churn vs stable gates
33. deterministic compaction vs model summary
34. prompt-intake classifier captures goal/preference/feedback
35. RTK output compression hides/shows right lines

## 8. Implementation outline, if/when proven

Do not implement until name/scope confirmed and posture switches to act.

Full vision stays in plan. Staged build to manage risk:

1. Research scripts/reports.
2. Runtime state/event log + compiled context view prototype.
3. `fs_read` + hidden handles + file capsules.
4. `fs_apply` batch mutation (`e/w/d/m`, `= ~ < > -`).
5. `fs_search` with policy auto-read and search capsules.
6. `ctx_budget` / `ctx_prune` / expansion handles.
7. Quiet validators.
8. RTK-style tool-output compression processor.
9. Scope/context-pack command/tool.
10. Controlled `code_probe`.
11. TypeScript LSP tools.
12. Prompt-intake classifier experiment.
13. No-bash profile.
14. Prompt/cache refactor: stable prompt + late runtime capsule.

Likely product files after name confirmation:

- `src/extensions/<name>/index.ts`
- `src/extensions/<name>/README.md`
- possible split: `state.ts`, `context.ts`, `read.ts`, `apply.ts`, `search.ts`, `validators.ts`, `probe.ts`, `lsp.ts`, `path-policy.ts`, `output-compression.ts`

Potential simplifications:

- Node `crypto` digest; no hash dependency initially.
- Strict stale-handle failure first; relocation later.
- Semantic operations in LSP, not text edit tool.
- Few stable tools with compact schemas; deterministic gates for policy.
- Settings only when policy thresholds require.

## 9. Repo/Pi constraints already known

From `AGENTS.md`:

- Strict TypeScript, erasable syntax only.
- No `any` unless necessary.
- Top-level imports only; avoid dynamic inline imports.
- New Tau extensions require product-level README.
- `.pi/extensions/` imports from `src/shared/` and is in-scope for refactors.
- After code changes run `mise run check`; no build/test unless requested.
- Never commit unless asked.
- Plan posture can write/edit only under `docs/plans/`.
- Creating Tau extension came through `/tau-new`, but still wait for name/scope.

Local files already read/useful:

- `package.json`: `pi.extensions` loads `./src/extensions/*/index.ts`.
- `tsconfig.json`: strict, erasable syntax, Node16, includes `src/**/*.ts` and `.pi/extensions/**/*.ts`.
- `src/extensions/qna/index.ts`: best Tau tool style reference (`defineTool`, `Type`, `StringEnum`, `Text`, `promptSnippet`, `promptGuidelines`).
- `.pi/extensions/tau-new/index.ts`: scaffolding flow.
- `.pi/extensions/tau-edit/index.ts`: selected resource injection; prototype for scope/context packs.
- `.pi/extensions/system-prompt-viewer/index.ts`: prompt/tool overhead inspection.
- `.pi/extensions/tau-schema-sync/index.ts`: settings watcher if needed.
- `src/extensions/soul/index.ts`, `src/extensions/soul/postures.ts`, `src/extensions/soul/README.md`: current posture/system-prompt behavior and cache-hostile lesson.
- `src/shared/events.ts`: Tau events if cross-extension coordination needed.

Pi API facts captured from docs/examples:

- Extension exports default `(pi: ExtensionAPI) => void`.
- Package extensions via `package.json` `pi.extensions`.
- Register tools with `pi.registerTool` or `defineTool`.
- Use `StringEnum` from `@earendil-works/pi-ai` for string enums.
- Mutating tools must use `withFileMutationQueue()`; multi-file locks sorted stable.
- Tool output must truncate; utilities include `truncateHead`, `truncateTail`, `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`, `formatSize`.
- `context` hook can filter/mutate messages before provider request; critical for projection.
- Hooks of interest: `before_agent_start`, `tool_call`, `tool_result`, `context`, `session_start`, `agent_start`, `agent_end`, `turn_end`.
- TUI renderers return components like `new Text(...)`; use theme and `keyText`/`keyHint`.

Do not reread Pi docs/examples unless an exact API detail blocks work.

## 10. What not to reread unless needed

- Pi docs/examples already read: extensions, TUI, extension examples.
- crumbs broad repo noise outside codex-compat patch files.
- hashline broad docs/tests outside exact behavior/context hygiene/RTK if needed.
- VCC/pi-vcc/pi-mrc docs already summarized here unless implementing exact compaction or lookup APIs.

Reread only if blocked:

- `src/extensions/qna/index.ts` for Tau tool style.
- `src/extensions/soul/index.ts` / `postures.ts` for prompt-cache refactor details.
- crumbs patch parser/executor/matcher/path-policy for exact patch behavior.
- hashline `hashline.ts`, `read.ts`, `edit.ts`, `write.ts`, `index.ts` for exact anchor behavior.
- pi-vcc / pi-mrc specific source for exact compaction/lookup implementation.

## 11. Pragmatic research completed

Reports live under `docs/research/agent-runtime/runs/`.

- `repo-size-profile.py`: primary corpus is `pi`, `codex`, `opencode`; `tau-agent` is tiny control. Big repos show 3k-token whole-read threshold covers roughly 79-84% owned text files; 5k covers roughly 87-91%. Generated/vendor/locks/schemas/changelogs/fixtures are main offenders.
- `context-pack-pricing-sim.py`: hardened sim includes one-turn exact discovery, zero tool noise, poor cache, and overbroad upfront packs. Upfront scoped packs win 87.4% of rows; iterative wins when discovery is exact/one-turn and upfront pack is sloppy.
- `turn-cost-sim.py`: percentile-based sim, not every file. Whole-read beats pruned discovery 67.8% and raw retained discovery 69.5%. Starting policy: auto-read owned source/test/config <=3k; consider <=5k with high scope confidence; range-read above; never auto-read generated/vendor.
- `cache-layout-research.md` + `cache-layout-sim.py`: provider-backed turn-by-turn sim for Anthropic/OpenAI/Gemini/xAI. Tool schemas are provider-visible cache identity. Runtime after latest user beats runtime before latest user for automatic prefix caches. Soul-style system rewrite is costly on posture switches. Mode-specific schemas can beat stable all-tools when tool modes are stable; repeated known modes may improve them further. Volatile compiled context before transcript is cache poison.
- `projection-compaction-sim.py`: turn-by-turn sim over five agentic sessions. Cost-only winner is pi-mrc KEEP/REF/DROP because visible context is tiny; quality-gated winner is hybrid deterministic sections + prompt-intake classifier. Raw transcript is cache-friendly but loses badly in long sessions from rent/context pressure. Rolling model summaries are cheap-looking but weak on exact recall and preference/correction fidelity. Conclusion: deterministic projection is normal lane; pi-mrc is cost floor; prompt classifier is worth a later measured test.
- `encoding-size-sim.py`: generated fixture payloads compare exact old/new, apply_patch, visible hashline, hidden handle tuple, verbose JSON handles, whole-file write, and LSP commands. Hidden handle tuple wins ordinary text edits; whole-file write wins tiny full config rewrite; LSP wins semantic refactors. Strict stale digest makes hidden handles pay retry cost on moved-block stale cases; apply_patch can be competitive there, so relocation/fail policy needs separate retry test. Visible hashlines remain stateless fallback but pay line-prefix rent.
- `schema-shape-sim.py`: object JSON is fine for tiny outputs; repeated rows favor tuple/legend or interned tuple rows. Interning wins when paths/status/codes repeat heavily. Columnar arrays are specialized because row reconstruction risk rises. Terse lines are cheap-looking but too ambiguous for high-stakes tool output.
- `json-payload-format-sim.py`: arbitrary JSON should compile to compact projection plus hidden raw JSON handle by default, especially for nested/high-fidelity payloads. Row-like payloads can use tuple/columnar forms; pretty JSON is debug/expand view only.
- `retry-cost-sim.py`: strict hidden handles are best for fresh/current reads and duplicate text. Exact-unique relocation is worth supporting after V1. Neighbor relocation needs uniqueness gates. Fuzzy/model relocation is not default. Semantic shifted edits route to LSP.
- `search-policy-sim.py`: auto-read ranges are safest default for uncertain scope and large files. Whole owned source/test/config <=3k is justified; <=5k only with high scope confidence. Generated/vendor stays blocked unless targeted. Scope packs are useful only when tight.
- `validator-cost-sim.py`: quiet validators win. Passing logs stay hidden/status-only. Failure capsules should show diagnostic lines plus hidden full log handle. Auto-format must refresh file capsules without model reread. Skipping validation only looks cheap before missed-failure risk is priced.
- `rtk-output-compression-sim.py`: typed compact tools beat shell reducers when structured output exists. RTK-style command-aware reducers are the shell escape-hatch lane: compact visible output plus hidden full log. Generic head/tail truncation is unsafe for high-critical-line outputs. Passing build/test output should be quiet/status-only.
- `prompt-rent-sim.py`: permanent prompt text is rent even when cached. Small stable kernel + late runtime + tool-error guidance wins. Mode shards can work, but mode/posture changes must not rewrite early system prompt.
- `tool-schema-overhead.py`: generic dispatcher is cheap on schema tokens but loses once wrong-tool/retry risk is priced. Coherent grouped tools are the sane product shape. Mode-specific schemas are token-competitive and win the quality gate in the sim, but stable all-tools + deterministic gates remain safer when provider cache churn/policy confusion dominates.
- `prompt-intake-classifier-sim.py`: no classifier is cheap only until missed corrections/scope changes cause retries or bad compaction. Regex-only misses nuance. Cheap prompt-only classifier is worth testing; high-impact confirmation is the safer product shape for durable preferences/reversals. Always asking users is accurate but annoying.
- `subagent-cost-sim.py`: deterministic scouts dominate local discovery. Prose subagents are waste because parent rereads and inherits summary risk. Typed-patch subagents can win web/broad synthesis when deterministic local scouting cannot answer. Parallel scouts only pay for truly independent lenses.
- `lsp-vs-edit-sim.py`: text handles win tiny obvious edits, especially with cold LSP. LSP workspace operations win rename/imports; LSP refs/diagnostics are strong when warm. Hybrid route is best: LSP for meaning, hidden-handle batch mutation for remaining text changes. Broken tsconfig/unavailable LSP must fail over to text/search; dynamic stringly code still needs grep/probe coverage.
- `capsule-lifetime-sim.py`: raw accumulation pays huge visible rent and carries stale evidence. Manual prune is too late/blunt. Auto-replace capsules are safe default. MRC KEEP/REF/DROP wins quality-gated cost in the sim, but only with solid lookup UX and critical-fact gates; budgeted projection is safer fallback. Aggressive drop is fake-cheap and fails quality.

## 12. Synthesis status

Synthesis written: `docs/research/agent-runtime/harness-research-synthesis.md`.

Recommendation from synthesis:

- No more broad paper sims before V1.
- Use `stateview` as research codename; final name still unconfirmed.
- Build one extension first, not a suite, because runtime state/projection/handles/lifecycle need one shared store.
- V1 spine: state store, context projection, `fs_read`, `fs_search`, `fs_apply`, `ctx_budget`, compact failure/log capsules.
- Not V1: fuzzy relocation, full LSP suite, classifier persistence, no-bash lockdown, generic dispatcher, mode-specific schemas as core architecture.
- Empirical checks still needed during/just before implementation: actual Pi provider request/cache capture, compact-format behavior eval, hidden lookup UX, LSP cold/warm timing, stale-handle frequency, validator dirty-scope cost.

Only after user approval, scaffold product code.
