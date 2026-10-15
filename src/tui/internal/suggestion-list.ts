/** The state every list above the input shares: the chosen row, and closing the list until the text changes. */

import { type Accessor, createSignal } from "solid-js";

/** What Tab or Enter does with the chosen row: replace a part of the input, or run a command. */
export type Completion =
  | {
      readonly type: "replace";
      readonly start: number;
      readonly end: number;
      readonly text: string;
    }
  | { readonly type: "run"; readonly name: string };

/** An open list as the input and its footer use it. */
export type SuggestionKeys = {
  readonly kind: "commands" | "files";
  /** Whether Tab and Enter would complete the chosen row. */
  readonly completes: () => boolean;
  readonly move: (step: number) => void;
  readonly dismiss: () => void;
  /** Nothing, so the key goes on to the input and the chat, when there is nothing to complete. */
  readonly completionFor: (key: "tab" | "return") => Completion | undefined;
};

/** The command list and the file list, fed by the input. */
export type InputSuggestions = {
  readonly setInput: (text: string, cursor: number) => void;
  /** The list that takes the keys now, if any is open. */
  readonly open: Accessor<SuggestionKeys | undefined>;
};

/** The chosen row of `rows` and whether Escape closed the list. `reset` follows a change of text. */
export const suggestionList = <Row>(rows: Accessor<readonly Row[]>) => {
  const [selected, setSelected] = createSignal(0);
  const [dismissed, setDismissed] = createSignal(false);

  return {
    selected,
    dismissed,
    chosen: (): Row | undefined => rows()[selected()],
    move: (step: number) => {
      const count = rows().length;
      if (count > 0) setSelected((index) => (index + step + count) % count);
    },
    dismiss: () => setDismissed(true),
    reset: () => {
      setSelected(0);
      setDismissed(false);
    },
  };
};
