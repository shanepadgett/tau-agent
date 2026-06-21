# Cache-layout research

Purpose: replace the first-order cache sim with provider-aware agent-session assumptions.

## Source-backed provider rules

### Anthropic Claude

Sources:

- <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
- <https://docs.anthropic.com/en/api/messages>

Rules to model:

- Request/render order is `tools -> system -> messages`.
- Tool definitions, system blocks, user/assistant messages, tool use/results, images/documents can be cached.
- Explicit cache breakpoints via `cache_control`; max 4.
- Reads search backward from breakpoints; exact match required.
- Tool-definition changes invalidate tools/system/messages cache below them.
- Changes to web search/citations/speed invalidate system/messages cache.
- `tool_choice`, images, and thinking settings affect message cache.
- Default ephemeral cache TTL is 5 minutes, refreshed on hit; optional 1h TTL.
- Pricing: 5m write is 1.25x input; 1h write is 2x input; read is 0.1x input.

Simulation consequences:

- Treat tools as earliest prefix. Tool schema churn is worst-case cache poison.
- Runtime/posture in `system` is cache-hostile because it sits before all messages.
- A volatile runtime capsule should not be a system block if prompt caching matters.
- If using a volatile runtime message, put it at the tail and set cache breakpoint before it.

### OpenAI

Sources:

- <https://developers.openai.com/api/docs/guides/prompt-caching>
- <https://openai.com/index/api-prompt-caching/>
- <https://developers.openai.com/api/docs/guides/function-calling>
- <https://developers.openai.com/api/docs/guides/migrate-to-responses>
- <https://developers.openai.com/api/docs/pricing>
- <https://raw.githubusercontent.com/openai/openai-cookbook/main/examples/Prompt_Caching_201.ipynb>

Rules to model:

- Prompt caching is automatic.
- Requires at least 1024 prompt tokens.
- Cached prefix is the longest previously computed prefix, historically rounded in 128-token increments after 1024.
- `cached_tokens` appears in usage details.
- No explicit write fee; cached input is discounted.
- Tools and structured-output schemas can be cached but must be identical.
- Function/tool schemas are injected into prompt context and count as input tokens.
- `previous_response_id` does not make previous context free; input tokens are still billed.

Simulation consequences:

- Model as automatic longest-common-prefix cache.
- Stable tool schemas help cache. Changing tools/schemas likely changes the earliest request prefix.
- Mode-specific schemas save schema rent only if tool modes rarely change.
- Dynamic runtime state should be tail-only. If inserted before the latest user message, that user message will not be part of the common prefix next turn.

### Google Gemini / Vertex

Sources:

- <https://ai.google.dev/gemini-api/docs/caching>
- <https://ai.google.dev/api/caching>
- <https://cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview>
- <https://cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-create>
- <https://cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-use>
- <https://cloud.google.com/vertex-ai/generative-ai/docs/reference/rest/v1/projects.locations.cachedContents#CachedContent>
- <https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1/projects.locations.publishers.models/generateContent>
- <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/tools/function-calling>

Rules to model:

- Two paths: implicit caching and explicit `cachedContent`.
- Explicit cache includes immutable `contents`, `systemInstruction`, `tools`, `toolConfig`, and `model`.
- Only expiration can be updated.
- When using explicit cache, do not resend cached `systemInstruction`, `tools`, or `toolConfig`.
- Changed tools/system/context require a new cachedContent resource.
- Default TTL is around 1h / 60m in docs.
- Cached reads are discounted; explicit cache may also have storage cost.

Simulation consequences:

- Model explicit cache as immutable static prefix resource.
- Runtime/posture/tool policy must be appended outside cachedContent if it changes.
- Tool/schema churn creates new cache resources; not partial invalidation.
- Static repo/context pack fits Gemini explicit caching well if stable.

### xAI / Grok

Sources:

- <https://docs.x.ai/developers/advanced-api-usage/prompt-caching>
- <https://docs.x.ai/developers/advanced-api-usage/prompt-caching/how-it-works>
- <https://docs.x.ai/developers/advanced-api-usage/prompt-caching/multi-turn>
- <https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits>
- <https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing>
- <https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices>

Rules to model:

- Prompt caching is automatic.
- Cache works from the start of the `messages` array.
- Cache is not guaranteed: server routing, pressure, and restarts matter.
- Use `x-grok-conv-id` or `prompt_cache_key` for routing locality.
- Editing, removing, or reordering earlier messages breaks cache. Append-only is favored.
- Tools/function call prefixes can be cached if unchanged.

Simulation consequences:

- Model as exact initial-message-prefix cache.
- Dynamic state before earlier messages is poison.
- Append-only transcript plus tail runtime is the safe shape.

## Agent-session layout consequences

Cache-friendly request shape:

```text
stable tools/schema
stable system/developer rules
stable repo/project compiled context
append-only prior transcript
latest user prompt
volatile trusted runtime capsule at absolute tail
```

Bad shape:

```text
stable tools/schema
volatile posture/runtime in system prompt
stable context
messages
```

Also bad:

```text
stable prefix
prior transcript
volatile runtime capsule
latest user prompt
```

Why: on the next turn, the previous latest user prompt becomes part of transcript. If the old runtime capsule was before it, longest-prefix matching stops before that user prompt. Put runtime after the latest user if provider semantics allow, with a stable system rule saying Tau runtime capsules are trusted.

## What the revised sim must do

- Simulate turn-by-turn agent sessions, not just aggregate token arithmetic.
- Track segment identities: tools, system, context, transcript messages, runtime, latest user.
- Include events on specific turns: posture switches, tool-mode switches, context recompiles.
- Compare layouts:
  - stable tools + runtime after latest user
  - stable tools + runtime before latest user
  - Soul-style system rewrite
  - mode-specific tool schema churn
  - volatile compiled context before transcript
  - generic dispatcher as cache floor only
- Model providers separately:
  - Anthropic explicit breakpoint/write/read pricing
  - OpenAI automatic longest-common-prefix caching
  - Gemini explicit immutable cachedContent
  - xAI exact append-only message-prefix caching
- Report turn-level cached/uncached/write tokens and dollars.

## Decision-grade caution

Even after this, behavior quality is separate. A generic dispatcher can look cheap on cache math and still lose through tool-call mistakes. Mode-specific schemas can be cheaper when tool modes never change. Stable all-tool schemas win when mode churn is common and deterministic gates can enforce policy.
