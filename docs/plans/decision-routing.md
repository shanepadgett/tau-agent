# Decision routing and account balancing

Status: implementation approved and completed; active-session verification awaits user `/reload` and confirmation.

## Agreed direction

Broaden the bounded-work route beyond small implementation changes to include repository questions, behavior checks, focused investigation, routine debugging, local refactors, and planning within existing patterns.

| Work | Model candidates and preference |
| --- | --- |
| Bounded questions, changes, investigations, and planning | Luna at max and Haiku at high as peers |
| Frontend implementation and design within established patterns | Prefer Sonnet at high |
| Difficult engineering, cross-system investigation, and substantial architecture planning | Prefer Sol at high; Sonnet at high is also eligible, allowing account pressure to influence selection |
| New design systems, new interaction models, exceptional creative scope, or architecture with major unresolved constraints | Opus at high, with a higher selection bar |

Whole pages using established design patterns do not inherently require Opus. Words such as “creative,” “redesign,” and “architecture” alone do not establish exceptional difficulty. Classify the amount of invention, uncertainty, and interaction between systems rather than file count or whether the request asks for implementation.

## Architecture direction

Expand the existing decisions routing system, rather than add another independent model selector.

Separate workload classification from model selection:

```text
First prompt or compaction handoff
  -> classify workload difficulty and specialty
  -> determine suitable model candidates
  -> select using preference, availability, and account pressure
  -> apply model and thinking level through existing routing path
```

Account pressure may change the choice among suitable models. It must not lower the required capability. Preserve the existing disabled-setting and explicit-model-selection behavior.

Keep selection at the existing first-prompt and compaction boundaries to avoid repeated switches that lose cache reuse. Any usage signal belongs in selection, not in the stable main-agent prompt.

## Account usage facts

The user has the $200 Codex plan and the $100 Claude plan. These prices do not establish comparable subscription allowances.

Pi's current extension API exposes request usage and context usage, not remaining subscription quota or reset times. Balancing must therefore use approximate locally observed usage unless a separate supported quota source is agreed later.

## Agreed balancing policy

Use approximate usage observed by Tau, measured in estimated API-equivalent cost over a rolling 24 hours. The target split is OpenAI 2/3 and Anthropic 1/3. The ratio reflects subscription spend as a user preference, not measured allowance.

Apply balancing as a soft preference among suitable candidates. Frontend and established-system design still prefer Sonnet; account usage must not cause a capability downgrade or bypass the higher bar for Opus.

## Implementation

### Routing

Keep the existing work-type keys. Broaden `quick` to cover bounded read-only work and bounded planning. Include substantial ordinary engineering and planning in `general`. Reserve `architecture` and `complex-design` for exceptional scope and difficulty; whole pages and ordinary creativity are not sufficient signals.

Replace each route's single model with ordered candidates:

```ts
interface RouteCandidate {
  provider: "openai-codex" | "anthropic";
  model: string;
  thinking: ThinkingLevel;
}

interface Route {
  description: string;
  candidates: RouteCandidate[];
}
```

Require at least one candidate. Defaults: `quick` has Luna then Haiku; `general` has Sol then Sonnet; frontend, writing, and simple design prefer Sonnet; exceptional architecture and complex design prefer Opus. Balance only the multi-provider peer candidates, not the existing lower-priority fallback chain. With no usable usage history, use the configured candidate order.

For peer candidates, compare observed provider cost divided by its target share. Prefer the less-used provider relative to that target; configured order breaks ties. This affects selection, not classifier probabilities. Retain the existing classifier failure, cancellation, explicit-selection, disabled-setting, and subscription-only guards.

The user approved replacing route-level `provider`, `model`, and `thinking` fields with `candidates`. Existing custom route settings require updating; the decisions README documents the new shape. No silent migration was added.

Balancing settings are `extensions.decisions.routing.balance.windowHours` (24 by default) and `balance.providerWeights` (`openai-codex: 2`, `anthropic: 1`). Dividing costs by weights gives the same ordering as dividing by normalized target shares.

### Shared usage reader

Extract the existing footer session-file scanning concern into a private shared usage module. Both the footer and routing use the same parsing and deduplication path; do not add a second independent accounting system or provider quota integration.

```ts
interface UsageWindow {
  startMs: number;
  endMs: number;
}

interface UsageCosts {
  total: number;
  openai: number;
  anthropic: number;
  unattributed: number;
}
```

The reader accepts a time window and cancellation signal and returns costs from local session records under Pi's configured agent directory. Routing requests the trailing 24 hours with a three-second accounting deadline; the footer retains its local-calendar-day total with a ten-second scan deadline. Preserve totals for usage that cannot be attributed reliably, but do not guess which subscription it consumed. Only explicit `openai-codex` and `anthropic` attribution affects balancing. Other providers, tool-result helper costs, and compaction costs without provider metadata remain in the total and unattributed bucket. Provider totals remain estimates of locally observed work, not exact account consumption.

Read usage only at routing boundaries and await it before model selection. Do not scan on every tool call, place account history in classifier state, or inject it into the main-agent prompt. Inject the usage reader into `registerRouting` so the selection boundary is explicit; no test-only injection or scaffolding is needed.

### Integration path

```text
decisions/index.ts constructs the routing dependencies
  -> input preclassification or before_agent_start / compaction handoff
  -> DecisionClient.classify("routing", prompt or handoff)
  -> route candidates + shared usage reader
  -> deterministic peer ordering
  -> existing model application and tau.decisions.route publication

footer daily refresh
  -> same shared usage reader, local-day window
  -> existing daily-cost rendering
```

Update decisions settings and route defaults, the decisions README and Tau help for changed usage, and the generated schema through the supported schema synchronization path. Do not edit the schema manually. Consult Pi compatibility and integration documentation before implementing API-dependent changes. No minimum-version change is proposed.

### Verification

Inspect final serialized requests across consecutive calls: the provider, model, and thinking effort may change at a routing boundary; usage accounting must not change serialized system content, tools, or historical messages on unchanged-model requests. Preserve the longest stable cache prefix.

Use read-only sample session analysis and permitted focused verification without adding or modifying tests. Complete repository checks after implementation. Extension changes require user `/reload` before runtime testing.

## Verification completed

- A read-only scan of existing session records completed in approximately 69 ms; provider buckets reconciled with the total, and pre-cancelled scans rejected.
- The shared reader preserved the old footer's daily total on existing session records, within floating-point rounding.
- In-memory routing exercises covered both peer preferences, the 2:1 tie, no history, fixed Sonnet and Opus routes, first-prompt and compaction selection, global and routing disablement, explicit selection, missing classifier credentials, accounting failure, cancellation, and OAuth-only availability. No tests, fixtures, or test-only exports were added.
- Offline capture of final serialized provider requests covered Luna, Sol, Haiku, Sonnet, and Opus without network requests. Identical contexts produced identical payloads. System instructions and tools remained stable. Codex retained its full historical prefix, with Luna at max and its existing priority mode. Anthropic retained historical content and recorded effort; its existing cache marker moved from the previous user message to the new tail.
- Live classification quality and active-host behavior remain unverified until the user reloads the changed extensions. Repository verification is reported separately when implementation finishes.

## Original implementation constraints

The relevant routing paths are `packages/agent/extensions/decisions/routing.ts`, `settings.ts`, and `classifier.ts`. Current route descriptions omit bounded questions, ordinary general work selects Sol, and architecture selects Opus. Haiku is currently a quick-route fallback rather than an equal candidate.

The footer's daily-cost scan in `packages/agent/extensions/footer/index.ts` aggregates local session records. It does not measure remaining subscription allowance, misses usage outside Tau, and cannot reliably attribute all helper usage to an account. A balancing design must address these limits before treating local cost as account pressure.

API prices and vendor benchmark results support the proposed direction but do not establish subscription quota consumption or performance equivalence in Tau. No new tests or test modifications are authorized.

## Next step

Run `/reload` before active-session verification. Remove this plan once the user confirms the work is complete.
