/**
 * The picker that `/model` opens: one line per model, the favorite models first, then the rest,
 * each sorted by provider, maker and model. Ctrl+F moves a model between the two.
 */

import type { Effect } from "effect";
import { createSignal } from "solid-js";
import type { Agent } from "../../core/Agent.ts";
import type { ChatAction } from "./chat-state.ts";
import type { PickerAction, PickerItem, PickerList } from "./Picker.tsx";

export type ListedModel = Effect.Success<Agent["Service"]["models"]>[number];
export type ModelRef = ListedModel["ref"];

/** What the model picker acts on. */
export type ModelPickerTarget = {
  readonly apply: (action: ChatAction) => void;
  readonly setModel: (ref: ModelRef) => void;
  /** Saves in the background that `ref` is a favorite, or no longer one. */
  readonly saveFavorite: (ref: ModelRef) => void;
};

export const refText = (ref: ModelRef) => `${ref.provider}/${ref.model}`;

/**
 * The picker on `models`, with `saved` first. Ctrl+F shows its change at once, even if saving it
 * fails.
 */
export const modelPicker =
  (target: ModelPickerTarget) =>
  ([models, saved]: readonly [readonly ListedModel[], readonly ModelRef[]]): PickerList => {
    const [favorites, setFavorites] = createSignal<ReadonlySet<string>>(
      new Set(saved.map(refText)),
    );

    const toggleFavorite = (ref: ModelRef) => {
      const text = refText(ref);
      const toggled = new Set(favorites());

      if (toggled.has(text)) toggled.delete(text);
      else toggled.add(text);

      setFavorites(toggled);
      target.saveFavorite(ref);
    };

    const modelItem = (listed: ListedModel): PickerItem => ({
      id: refText(listed.ref),
      label: listed.name,
      note: listed.ref.provider,
      search: `${listed.name} ${refText(listed.ref)}`,
      choose: () => {
        target.setModel(listed.ref);
        target.apply({ type: "info", text: `The model is now ${refText(listed.ref)}.` });
      },
    });

    const pin: PickerAction = {
      key: "ctrl+f",
      run: (selected) => {
        const listed = models.find((model) => refText(model.ref) === selected?.id);
        if (listed !== undefined) toggleFavorite(listed.ref);
      },
    };

    return {
      title: "Model",
      hint: "ctrl+f pin",
      actions: [pin],
      sections: () => modelSections(models, favorites()).map((section) => section.map(modelItem)),
    };
  };

/** Splits `models` into the favorites, as `provider/model` texts, and the rest. */
export const modelSections = (
  models: readonly ListedModel[],
  favorites: ReadonlySet<string>,
): readonly [favorites: ListedModel[], rest: ListedModel[]] => {
  const sorted = models.toSorted((left, right) =>
    compareKeys(sortKey(left.ref), sortKey(right.ref)),
  );

  const isFavorite = (listed: ListedModel) => favorites.has(refText(listed.ref));

  return [sorted.filter(isFavorite), sorted.filter((listed) => !isFavorite(listed))];
};

/**
 * The maker is the start of the model's name up to its first slash, such as `anthropic` in
 * `openrouter/anthropic/claude-haiku-5.5`. A model with no maker sorts first in its provider.
 */
const sortKey = (ref: ModelRef) => {
  const slash = ref.model.indexOf("/");
  const maker = slash < 0 ? "" : ref.model.slice(0, slash);
  return [ref.provider, maker, ref.model];
};

const compareKeys = (left: readonly string[], right: readonly string[]) => {
  for (const [index, part] of left.entries()) {
    const order = part.localeCompare(right[index] ?? "");
    if (order !== 0) return order;
  }

  return 0;
};
