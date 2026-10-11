# 02 Model routing

## Goal

Pick the agent model and thinking level from the kind of work the first prompt starts. Models differ in strengths:

- Anthropic models are better at design and prose.
- GPT-6.1 Sol is the best general coding agent for its cost and intelligence.
- Luna handles small, clear work well, but only at max reasoning.

## Agreed

- **First prompt and after each compaction.** The route is chosen on the session's first user prompt. After that, it changes only at a compaction, because compaction already discards the prompt cache. After a compaction, routing classifies the agent's note to self and switches automatically if the route changes ([04](04-context.md)). It uses the same explicit-choice rule: if the user picked the current model, compaction does not change it.
- **Routing by type of work, not effort tier.** Routing owns its own route table. This is an exception to `docs/standards/agent-runtime.md` for the main agent model; update that standard when implementing. Helper models, such as the reviewer and compaction, stay on effort tiers.
- **Subscription logins only.** The providers are `openai-codex` (ChatGPT subscription) and `anthropic` with a Claude subscription login, checked with `modelRegistry.isUsingOAuth(model)`. API keys are never used: not the `openai` provider, and not `anthropic` with an API key.
- **Fallback** is the `general` route.
- **Footer** shows that automatic selection is in use.
- **Direct model calls, no virtual model.** Routing calls `pi.setModel()` and `pi.setThinkingLevel()` once. Pi's per-request virtual-model routing is not needed when the model is fixed after the first prompt.
- **An explicit choice wins.** If the user picks a model before the session's first prompt, routing does not run in that session.

## Architecture

`routing.ts` in the `decisions` extension handles three Pi events:

```text
session_start ──▶ eligible = new session (no user messages on the branch)
model_select (source "set" or "cycle", not from routing) ──▶ eligible = false
input (interactive, idle, not a slash command, eligible) ──▶ start classify(routing)
before_agent_start (eligible)
  ──▶ await classification ──▶ pick route ──▶ resolve subscription fallback
  ──▶ pi.setModel(model) ──▶ pi.setThinkingLevel(level) ──▶ eligible = false
  ──▶ append tau.decisions.route, emit tau:decisions.route
```

- Pi emits `before_agent_start` before it builds the first request. Its source notes that this is where extension-driven model selection happens, so the first request already goes to the routed model.
- `pi.setModel()` records a `model_change` entry in the session but does not change the user's saved default model. It returns `false` when the provider has no login.
- Routing ignores the `model_select` event caused by its own `setModel()` call.
- Resumed and forked sessions already have user messages, so they are never routed.
- With no decision and no available route model, routing does nothing, and the session keeps its current model.

## Routes (default `decisions.routing.routes`)

| Route | Work it covers | Model | Thinking |
| --- | --- | --- | --- |
| `quick` | Small, clear changes to an existing system, even if a few clarifying questions are needed | `openai-codex/gpt-6-luna` | max |
| `general` | General coding and debugging | `openai-codex/gpt-6.1-sol` | high |
| `frontend` | Implementation involving front-end work | `anthropic/claude-sonnet-5-5` | high |
| `design` | UI and design-system work within an existing design system: tweaks and small reinventions | `anthropic/claude-sonnet-5-5` | high |
| `newDesign` | Hard UI and design-system work: entirely new paradigms | `anthropic/claude-opus-5-5` | high |
| `writing` | Prose, docs, wording | `anthropic/claude-sonnet-5-5` | medium |
| `architecture` | Software architecture and code planning | `anthropic/claude-opus-5-5` | high |

### Fallbacks when a subscription is missing

| Logged in | Claude routes (`frontend`, `design`, `newDesign`, `writing`, `architecture`) | `general` | `quick` |
| --- | --- | --- | --- |
| Both | As in the table above | Sol, high | Luna, max |
| ChatGPT only | Sol, high | Sol, high | Luna, max |
| Claude only | As in the table above | `anthropic/claude-sonnet-5-5`, high | `anthropic/claude-haiku-5-5`, high |

```ts
interface Route {
  description: string;  // becomes the classifier option text
  provider: "openai-codex" | "anthropic";
  model: string;
  thinking: ThinkingLevel;
}
```

## Classification

- State: `{ prompt }` for the first prompt.
- One `choice` question, `route`: "Which kind of work does this prompt start?" Its options are the route names, with their descriptions as criteria.
- Use the highest-probability route when it is at least 0.5. Otherwise use `general`.
- No decision, or a route whose provider lacks a subscription login, also uses `general`.

Before shipping, validate the wording against the 40 first prompts in the spike's `prompt-cases.json`, labeled by hand.

## Footer

The Tau footer already shows `ctx.model`, which is the routed model after `setModel()`. It adds an `auto:<route>` marker before the model, for example `auto:frontend · anthropic/claude-sonnet-5-5 (high)`.

- The footer learns the route from the `tau:decisions.route` event.
- On resume, it reads the latest `tau.decisions.route` entry on the branch.
- The marker disappears when the user changes the model, which the footer sees as a `model_select` event not caused by routing.

## Records

When the route is chosen, append `tau.decisions.route` with `{ route, probabilities, model, thinking, elapsedMs, status }`.
