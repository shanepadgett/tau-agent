// One-off, offline design check. Not part of the test suite.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { SessionManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import { ExtensionRunner } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js";
import { createExtensionRuntime } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { convertToLlm } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js";
import { Agent } from "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent.js";
import { AssistantMessageEventStream } from "../../node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js";
import { stream as anthropic } from "../../node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js";
import { stream as openai } from "../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const tool = name => ({ name, description: name, parameters: { type: "object", properties: {} } });
const read = tool("read"), search = tool("search");
const user = text => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const model = (provider, extra = {}) => ({
  id: "offline-design-check", name: "Offline check", provider,
  api: provider === "anthropic" ? "anthropic-messages" : "openai-responses",
  baseUrl: "https://offline.invalid", reasoning: false, input: ["text"],
  contextWindow: 100000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsMidConvoSystemMessages: true, ...extra },
});
const models = [
  model("anthropic", { supportsMidConvoToolChanges: true }),
  model("openai", { supportsAdditionalTools: true }),
  model("openai", { supportsToolSearch: true }),
];
const answer = m => ({ role: "assistant", content: [{ type: "text", text: "Done." }],
  api: m.api, provider: m.provider, model: m.id, usage, stopReason: "stop", timestamp: 2 });
const report = { scope: "Offline installed-Pi check; synthetic model compatibility flags; no model calls", placement: [], abort: [] };
let fetchCalls = 0;
const neverFetch = async () => { fetchCalls++; throw new Error("Offline transport stub reached"); };

function runnerFor(handler, manager = SessionManager.inMemory()) {
  return new ExtensionRunner([
    { path: "offline-check", handlers: new Map([["context_with_system", [handler]]]) },
  ], createExtensionRuntime(), process.cwd(), manager, {});
}

async function payload(m, messages) {
  let captured;
  const response = (m.provider === "anthropic" ? anthropic : openai)(m,
    { messages: convertToLlm(messages) }, {
      apiKey: "offline-placeholder", sessionId: "offline-soul-check", cacheRetention: "long",
      fetch: neverFetch, maxRetries: 0,
      onPayload: value => { captured = structuredClone(value); throw new Error("Captured before transport"); },
    });
  await response.result();
  assert.ok(captured, "Provider must reach the final payload hook");
  return captured;
}

// Cache breakpoints move as history grows. Compare model-visible content separately.
function contentOnly(value) {
  if (Array.isArray(value)) return value.map(contentOnly);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "cache_control").map(([key, item]) => [key, contentOnly(item)]));
  return value;
}

for (const m of models) {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "system", content: "Pi original", toolsAdded: [read], timestamp: 0 });
  manager.appendMessage(user("First task"));
  manager.appendMessage(answer(m));
  manager.appendMessage({ role: "system", content: "", toolsAdded: [search], timestamp: 3 });
  const anchor = manager.appendMessage(user("Availability changed"));
  const initialBaselineId = manager.appendCustomEntry("check.baseline", { text: "<communication>Original Soul</communication>" });
  manager.appendCustomEntry("check.update", { baselineEntryId: initialBaselineId, afterEntryId: anchor,
    text: '<context-update source="subagents">Only context-sync is available.</context-update>' });
  const hookObservations = [];
  const runner = runnerFor((event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    const baselineEntry = branch.findLast(e => e.type === "custom" && e.customType === "check.baseline");
    const updates = branch.filter(e => e.type === "custom" && e.customType === "check.update" && e.data.baselineEntryId === baselineEntry.id);
    const projection = ctx.sessionManager.buildSessionProjection();
    // This check exercises unmodified history through Pi's actual clone/transform boundary.
    assert.deepEqual(event.messages, projection.messages);
    hookObservations.push({ sameObject: event.messages[0] === projection.messages[0] });
    const output = [];
    for (const entry of projection.entries) {
      for (const message of entry.messages) {
        const copy = structuredClone(message);
        if (output.length === 0) { copy.content = baselineEntry.data.text; delete copy.sections; }
        output.push(copy);
      }
      for (const update of updates.filter(u => u.data.afterEntryId === entry.sourceEntry.id))
        output.push({ role: "custom", customType: "check.update", content: update.data.text, display: false, timestamp: 4 });
    }
    return { messages: output };
  }, manager);
  const first = await payload(m, await runner.emitContext(manager.buildSessionProjection().messages));
  manager.appendMessage(answer(m));
  manager.appendMessage(user("Next task"));
  const second = await payload(m, await runner.emitContext(manager.buildSessionProjection().messages));
  const field = m.provider === "anthropic" ? "messages" : "input";
  const old = contentOnly(first[field]);
  assert.deepEqual(contentOnly(second[field]).slice(0, old.length), old);
  assert.deepEqual(second.system, first.system);
  assert.deepEqual(second.tools, first.tools);
  const firstIndex = first[field].findIndex(item => JSON.stringify(item).includes("Only context-sync"));
  const secondIndex = second[field].findIndex(item => JSON.stringify(item).includes("Only context-sync"));
  assert.ok(firstIndex >= 0);
  assert.equal(secondIndex, firstIndex);
  const compaction = manager.appendCompaction("Earlier work summarized.", null, 300);
  manager.appendCustomEntry("check.baseline", { text: "<communication>Post-compaction Soul</communication>", compaction });
  const after = await payload(m, await runner.emitContext(manager.buildSessionProjection().messages));
  assert.ok(JSON.stringify(after).includes("Post-compaction Soul"));
  assert.ok(!JSON.stringify(after).includes("Only context-sync"));
  report.placement.push({ provider: m.provider, compat: m.compat, unchangedContentPrefix: true,
    unchangedSystemAndTools: true, firstUpdateIndex: firstIndex, secondUpdateIndex: secondIndex,
    postCompactionBaseline: true, staleUpdateAbsent: true,
    rawMessagePrefixEqual: JSON.stringify(second[field].slice(0, first[field].length)) === JSON.stringify(first[field]),
    projectionObjectsCloned: hookObservations.every(o => !o.sameObject) });
}

for (const mode of ["counting-stream-stub", "anthropic", "openai"]) {
  const m = model(mode === "anthropic" ? "anthropic" : "openai");
  let agent, streamCalls = 0, payloadCalls = 0, signalAtStream = false, hookCalls = 0;
  const runner = runnerFor((_event, ctx) => { hookCalls++; ctx.abort(); });
  runner.bindCore({}, {
    getModel: () => m, getScopedModels: () => [], isIdle: () => false,
    isProjectTrusted: () => true, getSignal: () => agent.signal, abort: () => agent.abort(),
    hasPendingMessages: () => false, shutdown: () => {}, getContextUsage: () => undefined,
    compact: () => {}, getSystemPrompt: () => "",
  });
  const fetchBefore = fetchCalls;
  agent = new Agent({ initialState: { model: m, systemPrompt: "Offline", tools: [] },
    transformContext: messages => runner.emitContext(messages), convertToLlm,
    streamFn: (_model, context, options) => {
      streamCalls++; signalAtStream = options.signal.aborted;
      if (mode !== "counting-stream-stub") return (mode === "anthropic" ? anthropic : openai)(m, context, {
        ...options, apiKey: "offline-placeholder", fetch: neverFetch, maxRetries: 0,
        onPayload: () => { payloadCalls++; },
      });
      const output = { ...answer(m), stopReason: "aborted", errorMessage: "offline stub" };
      const events = new AssistantMessageEventStream();
      events.push({ type: "error", reason: "aborted", error: output }); events.end();
      return events;
    },
  });
  await agent.prompt("Abort this before sending");
  report.abort.push({ mode, hookCalls, streamCalls, signalAtStream, payloadCalls,
    fetchCalls: fetchCalls - fetchBefore, finalStopReason: agent.state.messages.at(-1).stopReason });
}

report.transportControls = [];
for (const provider of ["anthropic", "openai"]) {
  const before = fetchCalls;
  const response = (provider === "anthropic" ? anthropic : openai)(model(provider),
    { messages: [user("Positive transport control")] },
    { apiKey: "offline-placeholder", fetch: neverFetch, maxRetries: 0 });
  await response.result();
  assert.equal(fetchCalls - before, 1, "Non-aborted request must reach the stub exactly once");
  report.transportControls.push({ provider, stubFetchCalls: fetchCalls - before });
}
report.totalStubFetchCalls = fetchCalls;
report.realNetworkCalls = 0;
writeFileSync(new URL("./soul-request-check-results.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
