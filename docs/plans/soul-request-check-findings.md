# Soul request-boundary check results

Ran `node docs/plans/soul-request-check.mjs` against the installed Pi dependencies. Raw results: `soul-request-check-results.json`.

No model requests or real network calls. Provider fetch functions were replaced with throwing local stubs. Non-aborted positive controls reached each stub exactly once, confirming that the stub was connected.

## Decision summary

The saved-update approach works in the exercised projection and serialization paths. The proposed abort is not a strict pre-provider gate: it stops HTTP in the two checked SDK paths, but Pi still enters the provider function and constructs its payload.

For a provider-independent pre-send guarantee, recommend a narrow Pi agent-loop change: check the abort signal after asynchronous context transformation and again immediately before calling the stream function. Do not implement that dependency change without approval.

## Saved update placement

Used the real `SessionManager`, `ExtensionRunner.emitContext`, `convertToLlm`, and provider stream functions. Captured final payloads through `onPayload` and stopped before transport.

The session contained an initial tool, a later tool declaration, and a saved availability update anchored to a session entry. A small proposed Soul projector replaced the leading prompt and inserted the update using `buildSessionProjection().entries`.

| Provider path | Update index before/after another turn | Existing content stable | Initial system/tools stable |
| --- | --- | --- | --- |
| Anthropic native tool changes | 3 / 3 | Yes | Yes |
| OpenAI additional tools | 5 / 5 | Yes | Yes |
| OpenAI client tool search | 6 / 6 | Yes | Yes |

After inserting a real session compaction entry and saving a new baseline, the next projection used the new baseline and did not replay the old generation's update.

Anthropic's raw message JSON prefix changed because Pi moves `cache_control` to the latest message. Removing only that metadata produced equal prior message content. OpenAI's raw prior-message prefix was equal. This verifies content stability, not a live provider cache hit.

The hook receives cloned message objects. Match projection boundaries by stable entry mapping/content, not object identity. The check verified equal projected content through the runner's clone boundary.

## Abort behavior

Used an actual `Agent` with `transformContext` wired to `ExtensionRunner.emitContext`. The real handler called `ctx.abort()`, bound to `agent.abort()`. This exercises the runner's handler/error behavior rather than directly throwing from a transform.

| Path | Stream calls after abort | Payload callbacks | Fetch calls | Final result |
| --- | --- | --- | --- | --- |
| Counting stream stub | 1 | 0 | 0 | aborted |
| Anthropic adapter and SDK | 1 | 1 | 0 | aborted |
| OpenAI Responses adapter and SDK | 1 | 1 | 0 | aborted |

The originally proposed “stream call count stays zero” check failed. The SDK transport checks passed: both observed the aborted signal before invoking fetch. Do not conflate those results.

Source trace explains this: `streamAssistantResponse` awaits the context transform, converts messages, resolves the API key, and calls `streamFunction` without checking cancellation between those steps. `AgentSession.abort()` calls `agent.abort()` before awaiting idle; the normal extension abort path reaches that method. Mode-specific override handlers were not instantiated in this check.

## Limits

- Synthetic model records enabled each relevant compatibility flag. This checks installed serializers, not live support for a specific model, OAuth, Codex, or every provider.
- Compaction was represented by `SessionManager.appendCompaction`, not an actual summarization call or full automatic-compaction/retry run.
- The projector is a small feasibility check, not Soul's finished implementation. It assumes otherwise unchanged conversation history. It does not establish behavior when another extension rewrites earlier messages.
- No production files, dependency code, or test-suite files changed. The executable and results are temporary planning artifacts.

## Source locations

- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js`: `emitContext`, `createContext`
- `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`: extension abort binding and `abort`
- `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js`: `streamAssistantResponse`
- `node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js`: `stream`, `convertMessages`
- `node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js`: `stream`
