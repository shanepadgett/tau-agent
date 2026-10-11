# 00 Decision runtime

## Architecture

This plan adds one system: the `decisions` extension (`packages/agent/extensions/decisions/`). It contains:

- the classifier runtime: model choice, timeouts, mapping failures to "no decision", and usage events
- the `decisions` settings object
- two features that live entirely inside it: answer first ([03](03-answer-first.md)) and routing ([02](02-routing.md))
- a `DecisionClient` for the one feature that lives elsewhere, the approval pre-filter in `tool-approval` ([01](01-approval.md))

`tool-approval` gets the client through a Tau event, following the existing `tau:eval.source-store` accept pattern.

```text
decisions extension
 ├─ classifier.ts   pick model per call, classify(), map failures
 ├─ answer-first.ts input + before_agent_start
 ├─ routing.ts      before_agent_start → pi.setModel() + pi.setThinkingLevel()
 └─ index.ts        settings, wiring, provides DecisionClient via "tau:decisions.client"
                                        ▲
tool-approval ── decisionClientFrom(pi) ┘
```

All Pi APIs used exist at Pi 1.1.0, the supported minimum: `ModelRegistry.getAvailableOfType`, `findOfType`, `classify`, `isUsingOAuth`, `pi.setModel`, `pi.setThinkingLevel`, and the request options `timeoutMs`, `maxRetries`, `maxRetryDelayMs`, and `signal`. No compatibility branches are needed.

## Settings (`extensions/decisions/settings.ts`, key `decisions`)

```jsonc
"decisions": {
  "enabled": true,                 // turns every decision feature on or off
  "classifier": "auto",            // "auto" (Jev if available, else Luna) | "jev" | "luna"
  "approval":    { "enabled": true },
  "answerFirst": { "enabled": true },
  "routing": {
    "enabled": true,
    "routes": { /* see 02-routing.md */ }
  }
}
```

- A feature runs only when `decisions.enabled` and its own `enabled` are both true.
- Thresholds and the 3-second timeout are code constants until real use shows they need to be settings.
- Context management ([04](04-context.md)) uses no decision model, so its settings live with the `compaction` extension, not here.

## Choosing the classifier

The candidate list is ordered. Before each decision, the runtime uses the first entry whose provider has credentials, checked with `getAvailableOfType("classifier", provider)`. That check is a local lookup, so a login mid-session takes effect on the next decision.

| Order | Model | Provider / id |
| --- | --- | --- |
| 1 | Jev | `typesafe/jev-latest`, `openrouter/~typesafe/jev-latest`, `opencode/jev-1.13`, `vercel-ai-gateway/typesafe-ai/jev`, `cloudflare-workers-ai/typesafe/jev` |
| 2 | Luna | `openai/gpt-6-luna`, `openrouter/openai/gpt-6-luna-decisions`, `vercel-ai-gateway/openai/gpt-6-luna-decisions` |

- `classifier: "jev"` or `"luna"` limits the list to that model's entries.
- Only the OpenRouter routes were benchmarked. Other providers may serve a different version, such as `jev-1.13`.
- There is no per-call failover from Jev to Luna. A failed call is "no decision".

## Shared types (`packages/agent/shared/decisions.ts`)

```ts
type DecisionFeature = "approval" | "answerFirst" | "routing";

interface DecisionClient {
  enabled(feature: DecisionFeature): boolean;
  classify(
    feature: DecisionFeature,
    ctx: ExtensionContext,
    state: JsonObject,
    questions: Record<string, ClassifierQuestion>,
  ): Promise<DecisionResult>;
}

type DecisionResult =
  | { status: "ok"; answers: Record<string, ClassifierAnswer>; model: string; elapsedMs: number; cost: number }
  | { status: "disabled" | "unavailable" | "timeout" | "error"; message: string; elapsedMs: number };
```

`TauAgentEvents` gains `"tau:decisions.client": { accept(client: DecisionClient): void }`. If the extension is missing or more than one client answers, `tool-approval` treats it as `unavailable`.

## Call path

1. `classify()` returns `disabled` when the master switch or the feature switch is off. It returns `unavailable` when no candidate has credentials.
2. Otherwise it calls `ctx.modelRegistry.classify(model, { state, questions }, { signal, timeoutMs: 3000, maxRetries: 0, maxRetryDelayMs: 0 })`. `signal` combines `ctx.signal` with `AbortSignal.timeout(3000)`.
   - `maxRetryDelayMs: 0` matters. Without it, an OpenAI 429 with `retry-after: 1728` caused Pi to keep waiting and retrying, stalling the spike for 15 minutes.
3. It maps the outcome:
   - stop reason `stop` with every requested answer present → `ok`
   - aborted by the timeout → `timeout`
   - anything else, including refusals such as `OpenAI refused to answer question "x"` → `error`
4. It emits `tau:decisions.usage` with `{ feature, model, cost, elapsedMs, status }`.

**Missing setup is never an error.** Every non-`ok` status means "no decision", and each feature then behaves exactly as Tau does today.

## Status

The extension shows one status line:

- `decisions: Jev (openrouter)` when a classifier is available
- `decisions: unavailable, no Jev or Luna credentials` when none is
- `decisions: off` when the master switch is off

## Files

- `extensions/decisions/{index,settings,classifier,answer-first,routing}.ts`
- `extensions/decisions/README.md`
- `shared/decisions.ts` and two entries in `shared/events.ts`
- A `tau-help` entry and separate decision-model spend in `cost-report`
- The settings schema regenerates through `tau-schema-sync`.

## Decided

- `cost-report` shows decision-model spend as its own line, from `tau:decisions.usage` events.
- On by default.
- No local runtime. Latency, memory, and startup time ruled it out; see `research.md`.
