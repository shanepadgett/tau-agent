# Token-efficient agent runtime research

## 0. Research question

Can an agent runtime cut cost, context waste, stale evidence, retries, and wrong edits by keeping exact runtime state outside the provider transcript and sending the model only a compact current view?

Core hypothesis:

> A coding agent should work from current runtime state. The transcript can remain available for audit and UI, but it should stop acting like working memory once it fills with stale searches, old reads, passing logs, duplicate evidence, and abandoned paths.

Research areas:

- compiled current context views
- file read/search capsules with hidden exact handles
- batch mutation and stale-read safety
- context cleanup and capsule lifecycle
- quiet validation
- tool-output compression
- controlled probes vs bash output
- LSP/code intelligence
- prompt/cache-aware runtime layout
- search/read/scope-pack policy
- subagents/scouts
- prompt-intake metadata classification
- compact output formats
- Pi/Tau capability boundaries

Related synthesis: `docs/research/agent-runtime/harness-research-synthesis.md`.

## 1. Provider context vs runtime state

Provider context is the text and tool schema sent to the model. It costs money every turn. It also shapes attention. Old evidence can keep influencing the model after newer evidence has replaced it.

Runtime state is local durable state: file snapshots, tool outputs, events, decisions, failures, hidden logs, and metadata. It can hold exact detail without sending all of it to the provider each turn.

Research model:

```text
raw events / exact artifacts
  -> typed runtime state
  -> deterministic current projection
  -> compact provider-visible context
  -> hidden lookup handles for exact detail
```

The current view usually needs:

- current objective and scope
- active constraints/preferences
- current file knowledge
- search results not yet covered by reads
- unresolved validator/security/data-loss failures
- decisions and open questions
- current runtime/tool policy

The current view usually drops or hides:

- search hits covered by later reads
- file reads superseded by edits/rereads
- validator failures resolved by later passes
- passing check logs
- raw tool output reduced into decisions/capsules
- stale duplicate evidence

Safety constraints:

- user requirements stay visible or pinned
- unresolved failures stay visible as compact diagnostics
- hidden handles do not count as evidence until expanded or looked up
- raw evidence can hide only when a current capsule or decision preserves the useful fact

Relevant deeper research:

- `runs/projection-compaction-sim/projection-compaction-sim.md`
- `runs/capsule-lifetime-sim/capsule-lifetime-sim.md`

## 2. File reads and file knowledge

File reads work best as visible capsules backed by hidden exact state.

Visible example:

```text
@f3 src/user.ts digest=9c31e2 lines=35..58
35| export function getName(user: User) {
36|   if (!user.profile) return "unknown";
37|   return user.name;
38| }
```

Hidden state for that handle includes path, digest/revision, line count, visible ranges, and exact snapshot content needed for validation or lookup.

Read policy evidence:

- owned source/test/config files <= 3k tokens are usually safe whole-read candidates
- <= 5k can be reasonable when scope confidence is high
- larger owned files favor targeted ranges
- generated/vendor/dist/coverage/snapshots should stay out of automatic reads
- binary/assets should never be read as text

Repo profile facts:

- 3k threshold covers about 79-84% of owned text files in large reference repos
- 5k covers about 87-91%
- `tau-agent`: 3k covers 80%; 5k covers 94.7%
- large offenders are generated files, lockfiles, schemas, fixtures, changelogs, vendor blobs

Relevant deeper research:

- `runs/repo-size-profile/repo-size-profile.md`
- `runs/turn-cost-sim/turn-cost-sim.md`
- `runs/search-policy-sim/search-policy-sim.md`

## 3. Search and scope context

Raw terminal-style search dumps create lasting noise. Search results should be grouped, compact, path-policy-aware, and easy to retire once file reads cover them.

Search output should support:

- grouped hits by file/symbol/path
- compact repeated rows
- range or whole-file auto-read under policy
- generated/vendor blocking by default
- hidden raw result detail when needed
- covered/superseded state once reads replace search evidence

Scope packs are upfront bundles of likely-relevant context. Precision matters more than size alone.

Evidence:

- upfront scoped packs beat iterative discovery in 87.4% of pricing rows
- bad/overbroad packs lose to one-turn exact discovery
- search-only is cheap per tool call and can still lose when it causes extra model turns
- whole-reading small owned files often beats another noisy discovery turn

Policy pressure from the sims:

- auto-read ranges for uncertain scope or large files
- whole-read small owned files under threshold
- block generated/vendor by default
- use scoped packs when selected files, failing stacks, or high-confidence scope exist

Relevant deeper research:

- `runs/context-pack-pricing-sim/context-pack-pricing-sim.md`
- `runs/search-policy-sim/search-policy-sim.md`
- `runs/turn-cost-sim/turn-cost-sim.md`

## 4. Batch mutation and edit addressing

The edit research compares exact old-string edits, patches, visible hashlines, hidden handles, whole-file writes, and LSP commands.

The strongest ordinary text-edit pattern is hidden handle + compact batch operations + stale digest check.

Operation vocabulary studied:

```text
= replace one line
~ replace inclusive range
< insert before line
> insert after line
- delete inclusive range
write/create file
delete file
move file
```

Safety properties studied:

- preflight all handles before writing
- digest match means line/range refs are trusted
- digest mismatch fails tight in the simplest safe version
- preflight failure prevents partial mutation
- successful mutation returns refreshed file capsules
- formatter/autofix changes refresh affected capsules

Evidence:

- hidden handle tuple wins ordinary text-edit fixtures
- LSP wins semantic refactors
- whole-file write wins tiny full config rewrites
- patch wins a stale moved-block fixture
- strict hidden handles are safest for fresh/current reads and duplicate lines
- exact-unique relocation looks promising after strict stale failure
- fuzzy/model relocation gets risky once wrong-edit cost is priced

Relevant deeper research:

- `runs/encoding-size-sim/encoding-size-sim.md`
- `runs/retry-cost-sim/retry-cost-sim.md`

## 5. Context lifecycle and cleanup

Capsules need lifecycle state: active, covered, superseded, stale, hidden, resolved, failed, or pinned.

Useful budget view shape:

```text
context 42k visible
@f4 src/foo.ts 3.2k current
@s9 search "old API" 1.1k covered by @f4/@f8, prunable
@v7 TypeScript failure 0.3k unresolved
hidden artifacts: 420k bytes
```

Lifecycle relationships studied:

- reads cover searches
- edits supersede old reads
- rereads supersede stale capsules
- passing validators resolve failures
- decisions replace raw probe/research output
- user requirements remain pinned
- unresolved failures remain visible compactly

Evidence:

- raw accumulation pays huge visible rent and carries stale evidence
- manual pruning is too late and too blunt
- automatic capsule replacement is safer
- MRC KEEP/REF/DROP wins quality-gated cost in the capsule-lifetime sim, with lookup UX as the main risk
- aggressive dropping is fake-cheap and fails quality

Relevant deeper research:

- `runs/capsule-lifetime-sim/capsule-lifetime-sim.md`
- `runs/projection-compaction-sim/projection-compaction-sim.md`

## 6. Validation lane

Validation output should keep passes out of model context and expose failures as compact diagnostics.

Observed shape:

- pass: hidden/status-only
- fail: compact visible diagnostic + hidden full log handle
- later pass: resolve prior failure capsule
- formatter/autofix: refresh affected file capsules

Failure capsule example:

```text
@v7 TypeScript failed
src/foo.ts:41 TS2322 string not assignable to number
src/bar.ts:9 unused import
full log: @log12
```

Evidence:

- quiet validators win the validation sim
- passing logs are pure context rent
- manual raw checks lose badly on visible rent
- skipping validation looks cheap only before missed-failure risk is priced
- auto-format integration matters because formatter changes can stale file capsules

Relevant deeper research:

- `runs/validator-cost-sim/validator-cost-sim.md`
- `runs/rtk-output-compression-sim/rtk-output-compression-sim.md`

## 7. Tool-output compression / RTK-style lane

RTK-related research here means command-aware output reduction.

Studied shape:

- command-aware reducers for git/test/build/lint/search/log output
- compact visible summary
- hidden full-output handle
- original/compacted sizes
- reducer/filter identity
- bypass/expand/debug path

Evidence:

- typed compact tools beat shell reducers when structured output exists
- quiet status handles win pass/noise scenarios
- command-aware reducers are useful for shell escape hatches
- generic head/tail truncation often hides the critical line
- raw output is a debug/expand view, not normal provider context

Relevant deeper research:

- `runs/rtk-output-compression-sim/rtk-output-compression-sim.md`
- `runs/json-payload-format-sim/json-payload-format-sim.md`
- `runs/schema-shape-sim/schema-shape-sim.md`

## 8. Bash vs controlled probes

Bash is useful, but it is noisy and security-sensitive. The research repeatedly points at controlled probes for small declared inspections and simulations.

Probe dimensions studied conceptually:

- simulation/math/token experiments
- file inspection/parsing over declared inputs
- diff preview without write
- possible apply path through the mutation pipeline

Security/output constraints:

- no network by default
- minimal stripped environment
- no secrets by default
- declared read/write globs
- time/memory/output caps
- compact output + hidden full log

Relevant deeper research:

- `runs/rtk-output-compression-sim/rtk-output-compression-sim.md`
- `runs/lsp-vs-edit-sim/lsp-vs-edit-sim.md`

## 9. LSP/code intelligence

Grep finds strings. LSP finds meaning.

LSP is relevant for:

- rename symbol
- find references
- go to definition
- diagnostics
- organize imports
- hover/signature/type info

Evidence:

- text handles win tiny obvious edits, especially with cold LSP
- LSP workspace edit wins rename/import scenarios
- LSP refs/diagnostics are strong when warm
- broken tsconfig/unavailable LSP needs fallback
- dynamic/stringly APIs still need grep/probe coverage

Relevant deeper research:

- `runs/lsp-vs-edit-sim/lsp-vs-edit-sim.md`
- `runs/encoding-size-sim/encoding-size-sim.md`

## 10. Prompt/cache layout

Prompt caching research studies where volatile runtime state should live.

Cache-friendly abstract request shape:

```text
stable tools/schema
stable system/developer rules
stable durable project guidance
append-only transcript or stable compiled base
latest user prompt
volatile trusted runtime capsule at absolute tail
```

Cache-hostile shapes:

- volatile posture/runtime in system prompt
- volatile compiled context before transcript
- tool schema changes every turn
- giant permanent prompt with rare edge-case guidance

Evidence:

- runtime after latest user beats runtime before latest user for automatic longest-prefix caches
- Soul-style system rewrite is cache-hostile on posture switches
- tool schemas are provider-visible cache identity
- mode-specific schemas can be token-competitive when modes are stable, but schema churn matters
- generic dispatcher is cheap on schema tokens and loses once wrong-tool/retry risk is priced
- small stable kernel + late runtime + tool-error guidance wins prompt-rent sim

Relevant deeper research:

- `cache-layout-research.md`
- `runs/cache-layout-sim/cache-layout-sim.md`
- `runs/prompt-rent-sim/prompt-rent-sim.md`
- `runs/tool-schema-overhead/tool-schema-overhead.md`

## 11. Tool schema surface

The research compares tool-shape pressure without settling final names.

Shapes studied:

- one generic dispatcher: low schema rent, higher wrong-tool/retry risk
- many tiny tools: clear, high schema rent
- coherent grouped tools: middle ground
- mode-specific tools: efficient if modes are stable, sensitive to cache churn
- dynamic per-turn schemas: cache-hostile

Tool-surface categories discussed:

- context/runtime view and cleanup
- filesystem read/search/apply
- validation/status/log lookup
- git/status/diff compact tools
- probe execution
- LSP/code intelligence
- hidden artifact lookup/expand

Evidence:

- generic dispatcher wins some raw cost rows and fails quality gate
- coherent grouped tools are a sane middle ground
- many tiny tools carry schema rent
- rare edge-case guidance fits better in tool errors/results than permanent schemas

Relevant deeper research:

- `runs/tool-schema-overhead/tool-schema-overhead.md`
- `runs/schema-shape-sim/schema-shape-sim.md`

## 12. Subagents and scouts

Subagent research separates deterministic local discovery from model subagents.

Local repo discovery usually favors deterministic scouts:

- exact paths
- symbols/ranges
- dependency edges
- typed context patches
- no prose summaries that force parent rereads

Typed patch output shape studied:

```json
{
  "add_context": [{"path":"src/auth.ts","ranges":[[40,90]],"reason":"token validation"}],
  "drop": ["@s3"],
  "open_questions": ["confirm middleware order"]
}
```

Evidence:

- deterministic scouts dominate local discovery in sims
- prose subagents are usually waste because parent rereads and inherits summary risk
- typed-patch subagents can win web/broad synthesis when deterministic local scouting cannot answer
- parallel scouts only pay for truly independent lenses

Relevant deeper research:

- `runs/subagent-cost-sim/subagent-cost-sim.md`

## 13. Prompt-intake classifier

Open research idea: classify each user prompt cheaply while main work proceeds, then use that metadata for projection/compaction.

Candidate labels:

- new goal
- same-goal refinement
- scope change
- correction/feedback
- durable preference
- temporary instruction
- blocker
- decision/approval
- reversal
- topic handoff
- clarification needed

Evidence:

- no classifier is cheap only until missed corrections/scope changes cause retries or bad compaction
- regex-only misses nuance
- cheap prompt-only classifier is worth testing
- always asking users is accurate but annoying
- high-impact confirmation is safer for durable preferences/reversals

Relevant deeper research:

- `runs/prompt-intake-classifier-sim/prompt-intake-classifier-sim.md`
- `runs/projection-compaction-sim/projection-compaction-sim.md`

## 14. Compact output formats

Format research studies how repeated rows and JSON-like payloads should appear in visible context.

Observed format pressure:

- row-like outputs: tuple rows with a legend
- repeated paths/status/codes: interned tuple rows
- nested/high-fidelity JSON: compact projection + hidden raw JSON handle
- arbitrary logs: reducer capsule + hidden full log
- tiny one-off objects: minified JSON is fine
- pretty JSON: debug/expand view

Evidence:

- object JSON is fine for tiny outputs but loses quickly with repeated rows
- interned tuple rows win repeated path/status/code datasets
- columnar arrays are specialized because row reconstruction risk is higher
- projection + hidden raw wins most arbitrary JSON cases
- terse lines are ambiguous for high-stakes output

Relevant deeper research:

- `runs/schema-shape-sim/schema-shape-sim.md`
- `runs/json-payload-format-sim/json-payload-format-sim.md`

## 15. Pi/Tau capability boundaries

Pi/Tau research looked at what extensions/prompts can cover and where runtime support may be needed.

Known Pi extension surfaces:

- register/override tools
- switch active tool sets
- context hook can filter/mutate messages before provider request
- `before_provider_request` can inspect/replace provider payload
- compaction hooks can replace summaries
- custom session entries persist state outside LLM context
- custom messages inject context into LLM context
- tool_result hooks can reduce output
- tool_call hooks can block/gate/mutate calls
- UI/status/widgets/commands can expose budget/status

Likely extension-reachable areas:

- managed file tools
- compact search tools
- validator wrappers
- tool-output reducers
- context budget/status UI
- custom compaction summaries
- prompt/cache instrumentation
- prompt/posture experiments

Runtime-level pressure:

- first-class provider-context projection rather than filtering stored transcript after the fact
- stable-prefix/tail-runtime request layout across providers
- cache breakpoints/accounting as an API
- hidden artifact store integrated with session tree/branching
- first-class capsule lifecycle
- validator scheduler with dirty-scope mapping
- tool-schema mode switching with provider-cache awareness
- SDK/runtime APIs for compiled context and lookup

Relevant deeper docs:

- Pi `docs/extensions.md`
- Pi `docs/compaction.md`
- Pi `docs/session-format.md`
- Pi `docs/sdk.md`
- current Tau/Soul behavior: `src/extensions/soul/index.ts`, `src/extensions/soul/postures.ts`

## 16. Dependency relationships between ideas

The research exposes dependencies between topic areas:

- file handles need a runtime state/artifact model
- batch mutation needs file capsules and stale checks
- quiet validators need a capsule lifecycle to retire failures
- formatter integration needs refreshed file capsules
- scope packs need search/read policy and context-budget awareness
- RTK/log reducers need hidden artifact lookup
- LSP edits need mutation integration or workspace-edit application rules
- prompt-cache layout needs real provider payload measurement
- prompt-intake classifier only matters if projection/compaction uses the metadata
- subagent typed patches only matter if parent context can accept add/drop capsule deltas

These relationships are useful when discussing which research question blocks another.

## 17. Measurement targets

Prototype/evaluation targets implied by the research:

- fewer rereads after edits
- fewer repeated search/read turns
- lower active visible context over time
- passing checks not retained in provider context
- stale handles fail safely
- old capsules retire automatically
- model uses file handles without confusion
- context budget makes rent visible
- provider payload/cache data confirms stable-prefix behavior

Behavioral demo used in research:

1. Search for symbol.
2. Auto-read relevant owned context.
3. Apply several edits across files in one call.
4. Return refreshed capsules.
5. Run/check quietly.
6. Show old search/read/check noise retired in context budget.

## 18. Open research risks

Open questions across the docs:

- exact provider payload/cache shape in real Pi sessions
- whether volatile runtime can reliably live after latest user for all providers
- hidden lookup UX: model must not treat handles as known evidence
- stale-handle frequency in real edit loops
- safe relocation policy after digest mismatch
- LSP cold/warm latency on real repos
- validator dirty-scope cost vs missed failures
- tool-schema churn vs stable schemas in real usage
- compact format comprehension and retry rate
- prompt-intake classifier false positives, especially durable preferences
- security/secrets/prompt-injection handling for hidden logs and probes

## 19. Research map

| Topic | Read when needed |
|---|---|
| Provider cache layout / tail runtime / tool schemas | `cache-layout-research.md`, `runs/cache-layout-sim/cache-layout-sim.md` |
| Prompt size / permanent rules | `runs/prompt-rent-sim/prompt-rent-sim.md` |
| Tool schema shape | `runs/tool-schema-overhead/tool-schema-overhead.md` |
| Context projection / compaction strategies | `runs/projection-compaction-sim/projection-compaction-sim.md` |
| Capsule lifecycle / pruning | `runs/capsule-lifetime-sim/capsule-lifetime-sim.md` |
| Repo file-size thresholds | `runs/repo-size-profile/repo-size-profile.md` |
| Whole-read vs discovery turns | `runs/turn-cost-sim/turn-cost-sim.md` |
| Search/read/scope pack policy | `runs/search-policy-sim/search-policy-sim.md`, `runs/context-pack-pricing-sim/context-pack-pricing-sim.md` |
| Edit encoding / hidden handles / patch fallback | `runs/encoding-size-sim/encoding-size-sim.md`, `runs/retry-cost-sim/retry-cost-sim.md` |
| Validator behavior | `runs/validator-cost-sim/validator-cost-sim.md` |
| RTK/tool-output compression | `runs/rtk-output-compression-sim/rtk-output-compression-sim.md` |
| Repeated row / JSON formats | `runs/schema-shape-sim/schema-shape-sim.md`, `runs/json-payload-format-sim/json-payload-format-sim.md` |
| LSP vs text/probe | `runs/lsp-vs-edit-sim/lsp-vs-edit-sim.md` |
| Subagents/scouts | `runs/subagent-cost-sim/subagent-cost-sim.md` |
| Prompt-intake classifier | `runs/prompt-intake-classifier-sim/prompt-intake-classifier-sim.md` |
| Pi extension capability | Pi `docs/extensions.md`, `docs/compaction.md`, `docs/session-format.md`, `docs/sdk.md` |
| Current Tau/Soul behavior | `src/extensions/soul/index.ts`, `src/extensions/soul/postures.ts` |

## 20. Post-compaction prompt

Read `docs/research/agent-runtime/token-efficient-agent-harness-research.md`. Use the detailed run reports only when discussing that specific topic. Focus on ideas, primitives, evidence, and tool surfaces.
