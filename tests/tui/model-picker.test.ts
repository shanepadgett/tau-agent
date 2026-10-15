/**
 * The order of `/model`: favorites first, each section by provider, maker and model. A unit test
 * because the order has many cases; the flow test in `chat.test.ts` shows it on screen.
 */

import { expect, test } from "bun:test";
import { ProviderId } from "../../src/ai/Providers.ts";
import { type ListedModel, modelSections, refText } from "../../src/tui/internal/model-picker.ts";

const listed = (text: string): ListedModel => {
  const slash = text.indexOf("/");
  const ref = { provider: ProviderId.make(text.slice(0, slash)), model: text.slice(slash + 1) };
  return { ref, name: text, contextTokens: 200_000, thinking: [] };
};

const MODELS = [
  "openrouter/openai/gpt-6-mini",
  "openai/gpt-6",
  "openrouter/anthropic/claude-haiku-5.5",
  "anthropic/claude-sonnet-5-5",
  "openrouter/auto",
  "anthropic/claude-opus-5",
].map(listed);

const texts = (section: readonly ReturnType<typeof listed>[]) =>
  section.map((model) => refText(model.ref));

test("without favorites, every model sorts by provider, then maker, then model", () => {
  const [favorites, rest] = modelSections(MODELS, new Set());

  expect(favorites).toEqual([]);

  expect(texts(rest)).toEqual([
    "anthropic/claude-opus-5",
    "anthropic/claude-sonnet-5-5",
    "openai/gpt-6",
    "openrouter/auto",
    "openrouter/anthropic/claude-haiku-5.5",
    "openrouter/openai/gpt-6-mini",
  ]);
});

test("favorites come out of the rest, in the same order, and an unlisted favorite is not shown", () => {
  const saved = new Set([
    "openrouter/openai/gpt-6-mini",
    "anthropic/claude-sonnet-5-5",
    "openai/gone",
  ]);

  const [favorites, rest] = modelSections(MODELS, saved);

  expect(texts(favorites)).toEqual(["anthropic/claude-sonnet-5-5", "openrouter/openai/gpt-6-mini"]);

  expect(texts(rest)).toEqual([
    "anthropic/claude-opus-5",
    "openai/gpt-6",
    "openrouter/auto",
    "openrouter/anthropic/claude-haiku-5.5",
  ]);
});
