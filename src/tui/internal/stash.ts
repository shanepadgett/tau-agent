/** Ctrl+S, which parks the input's text, and the `/pop` picker, which brings a stash back or discards it. */

import { DateTime, Duration, Effect } from "effect";
import type { Stash, Stashes } from "../../core/Stashes.ts";
import type { ChatAction } from "./chat-state.ts";
import type { PickerAction, PickerItem, PickerList } from "./Picker.tsx";

const TITLE = "Stash";

/** The input editor, as the chat sees it. */
export type InputEditor = {
  readonly read: () => string;
  readonly write: (text: string) => void;
};

/** What stashing and popping act on. */
export type StashTarget = {
  readonly stashes: Stashes["Service"];
  /** The project folder; each folder has its own stashes. */
  readonly directory: string;
  readonly editor: InputEditor;
  readonly apply: (action: ChatAction) => void;
  /** Runs `effect` in the background. */
  readonly fork: (effect: Effect.Effect<void>) => void;
  /** Replaces the open picker, or closes it when given none. */
  readonly show: (picker: PickerList | undefined) => void;
};

const failed = (target: Pick<StashTarget, "apply">) => (error: { readonly path: string }) =>
  Effect.sync(() => {
    target.apply({ type: "notice", text: `Could not use the stashes in ${error.path}.` });
  });

/** Parks the input's text and clears the input. An empty input does nothing. */
export const stashInput = (target: Omit<StashTarget, "show">) => () => {
  const text = target.editor.read().trim();
  if (text === "") return;

  target.fork(
    target.stashes.add(target.directory, text).pipe(
      Effect.map((outcome) => {
        if (outcome === "duplicate") {
          target.apply({ type: "info", text: "Already stashed." });
          return;
        }

        target.editor.write("");
        target.apply({ type: "info", text: "Stashed. Bring it back with /pop." });
      }),
      Effect.catchTag("StashesError", failed(target)),
    ),
  );
};

/** Opens the `/pop` picker, or says that nothing is stashed. */
export const openPop = (target: StashTarget) =>
  target.stashes.list(target.directory).pipe(
    Effect.flatMap((found) => DateTime.now.pipe(Effect.map((now) => ({ found, now })))),
    Effect.map(({ found, now }) => {
      if (found.length === 0) {
        target.apply({
          type: "info",
          text: "Nothing is stashed. Press Ctrl+S to stash the input.",
        });

        return;
      }

      target.show(listPicker(target, found, now));
    }),
    Effect.catchTag("StashesError", failed(target)),
  );

const listPicker = (
  target: StashTarget,
  found: readonly Stash[],
  now: DateTime.Utc,
): PickerList => {
  const discard: PickerAction = {
    key: "ctrl+d",
    run: (selected) => {
      const stash = found.find((each) => String(each.id) === selected?.id);
      if (stash !== undefined) target.show(confirmPicker(target, stash, found, now));
    },
  };

  return {
    title: TITLE,
    hint: "enter pop · ctrl+d discard · esc close",
    actions: [discard],
    sections: () => [
      found.map((stash) =>
        stashItem(stash, now, () => {
          pop(target, stash);
        }),
      ),
    ],
  };
};

/** Asks before a stash goes: Enter discards it, Escape keeps it. */
const confirmPicker = (
  target: StashTarget,
  stash: Stash,
  found: readonly Stash[],
  now: DateTime.Utc,
): PickerList => {
  const backToList = () => {
    target.show(listPicker(target, found, now));
  };

  const discard = () => {
    target.fork(
      target.stashes
        .remove(stash.id)
        .pipe(Effect.andThen(openPop(target)), Effect.catchTag("StashesError", failed(target))),
    );
  };

  return {
    title: TITLE,
    hint: "enter discard · esc keep",
    sections: () => [[stashItem(stash, now, discard)]],
    back: backToList,
    keepsOpen: true,
  };
};

/** Puts the stash's text after what the input holds, so no draft is lost, and removes the stash. */
const pop = (target: StashTarget, stash: Stash) => {
  const draft = [target.editor.read(), stash.text].filter((part) => part !== "");
  target.editor.write(draft.join("\n\n"));

  target.fork(
    target.stashes.remove(stash.id).pipe(Effect.catchTag("StashesError", failed(target))),
  );
};

const stashItem = (stash: Stash, now: DateTime.Utc, choose: () => void): PickerItem => {
  const [first = "", ...rest] = stash.text.split("\n").filter((line) => line.trim() !== "");
  const label = first.trim();
  const detail = rest.map((line) => line.trim()).join(" ");

  return {
    id: String(stash.id),
    label,
    note: ageText(DateTime.distance(stash.createdAt, now)),
    detail: detail === "" ? undefined : detail,
    search: stash.text,
    choose,
  };
};

const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

/** Such as `now`, `5m`, `3h` or `2d`. */
const ageText = (age: Duration.Duration) => {
  const minutes = Math.floor(Duration.toMinutes(age));
  if (minutes < 1) return "now";
  if (minutes < MINUTES_PER_HOUR) return `${minutes}m`;
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) return `${hours}h`;
  return `${Math.floor(hours / HOURS_PER_DAY)}d`;
};
