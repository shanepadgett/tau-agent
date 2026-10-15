/** Latest-call cache usage follows the same events in live chat and saved history. */

import { expect, test } from "bun:test";
import type { ModelCall } from "../../src/core/Client.ts";
import { applyActions, replay } from "../../src/tui/internal/chat-state.ts";
import { options } from "../support/agent-harness.ts";

const call = (tokens: ModelCall["tokens"]): ModelCall => ({
  model: options.model,
  tokens,
  contextTokens: 128000,
  cost: undefined,
});

const event = (tokens: ModelCall["tokens"]) =>
  ({ type: "model-call-ended", call: call(tokens) }) as const;

for (const [name, tokens, share] of [
  [
    "partial hit excludes output and does not count cache tokens twice",
    { input: 42000, output: 500, cacheRead: 36000, cacheWrite: 1000 },
    6 / 7,
  ],
  ["explicit cache miss", { input: 42000, cacheRead: 0 }, 0],
  ["full hit", { input: 42000, cacheRead: 42000 }, 1],
  ["missing cache counts", { input: 42000 }, undefined],
  ["missing input total", { cacheRead: 36000 }, undefined],
  ["zero input total", { input: 0, cacheRead: 0 }, undefined],
] as const) {
  test(name, () => {
    expect(replay([event(tokens)]).usage?.cacheHitShare).toBe(share);
  });
}

test("new calls replace cache usage and running calls retain the last completed value", () => {
  const history = [event({ input: 100, cacheRead: 90 })];
  const previous = replay(history);
  expect(previous.usage?.cacheHitShare).toBe(0.9);
  const running = applyActions(previous, [{ type: "run-started", prompt: "Next" }]);
  expect(running.usage?.cacheHitShare).toBe(0.9);
  const unknown = event({ input: 100 });
  expect(applyActions(running, [unknown]).usage?.cacheHitShare).toBeUndefined();
  expect(replay([...history, unknown]).usage?.cacheHitShare).toBeUndefined();
  expect(replay([]).usage).toBeUndefined();
});
