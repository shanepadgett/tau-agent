/**
 * Thinking levels: which levels a model offers from its models.dev entry, the nearest offered level,
 * and the request fields each protocol gets. Unit tests, because each protocol and option has its
 * own case.
 */

import { expect, test } from "bun:test";
import { Option, type Schema } from "effect";
import { modelsDevProfile } from "../../src/ai/internal/catalog/models-dev.ts";
import { thinkingFields } from "../../src/ai/internal/protocols/thinking.ts";
import {
  clampThinking,
  type ModelProfile,
  type Protocol,
  thinkingLevels,
} from "../../src/ai/ModelProfile.ts";

const profileWith = (options: Schema.Json, protocol: Protocol = "anthropic"): ModelProfile => {
  const model = {
    id: "model",
    name: "Model",
    reasoning: true,
    tool_call: true,
    limit: { context: 200_000, output: 64_000 },
    reasoning_options: options,
  };

  const catalog = { provider: { models: { model } } };

  return Option.getOrThrow(
    modelsDevProfile(catalog, { provider: "provider", modelId: "model" }, protocol),
  );
};

const levelsOf = (options: Schema.Json) => thinkingLevels(profileWith(options).thinking);

test("each models.dev option gives the levels the model offers", () => {
  const haiku = [
    { type: "toggle" },
    { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
  ];

  expect(levelsOf(haiku)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);

  expect(levelsOf([{ type: "effort", values: ["none", "low", "high"] }])).toEqual([
    "off",
    "low",
    "high",
  ]);

  expect(levelsOf([{ type: "effort", values: ["minimal", "medium"] }])).toEqual(["low", "medium"]);

  expect(levelsOf([{ type: "effort", values: ["low", "high", "max"] }])).toEqual([
    "low",
    "high",
    "max",
  ]);

  expect(levelsOf([{ type: "budget_tokens", min: 1024 }])).toEqual([
    "off",
    "low",
    "medium",
    "high",
    "max",
  ]);

  expect(levelsOf([{ type: "toggle" }])).toEqual(["off", "medium"]);
  expect(levelsOf([])).toEqual([]);
  expect(levelsOf(null)).toEqual([]);
});

test("a level the model lacks moves to the next one up, or else down", () => {
  expect(clampThinking(["low", "high", "max"], "medium")).toBe("high");
  expect(clampThinking(["low", "high", "max"], "xhigh")).toBe("max");
  expect(clampThinking(["low", "medium", "high"], "max")).toBe("high");
  expect(clampThinking(["low", "high"], "off")).toBe("low");
  expect(clampThinking([], "medium")).toBeUndefined();
});

test("each protocol gets the level in its own fields", () => {
  const effort = [{ type: "toggle" }, { type: "effort", values: ["none", "low", "high", "max"] }];

  expect(thinkingFields(profileWith(effort, "anthropic"), "high")).toEqual({
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
  });

  expect(thinkingFields(profileWith(effort, "anthropic"), "off")).toEqual({
    thinking: { type: "disabled" },
  });

  expect(thinkingFields(profileWith(effort, "openaiResponses"), "off")).toEqual({
    reasoning: { effort: "none" },
  });

  expect(thinkingFields(profileWith(effort, "openrouter"), "max")).toEqual({
    reasoning: { effort: "max" },
  });

  expect(thinkingFields(profileWith(effort, "openaiChat"), "low")).toEqual({
    reasoning_effort: "low",
  });

  const budget = [{ type: "budget_tokens", min: 1024 }];

  expect(thinkingFields(profileWith(budget, "anthropic"), "medium")).toEqual({
    max_tokens: 64_000,
    thinking: { type: "enabled", budget_tokens: 10_240 },
  });

  expect(thinkingFields(profileWith(budget, "anthropic"), "max")).toEqual({
    max_tokens: 64_000,
    thinking: { type: "enabled", budget_tokens: 32_000 },
  });

  expect(thinkingFields(profileWith(budget, "openrouter"), "off")).toEqual({
    reasoning: { enabled: false },
  });
});
