/**
 * A list to pick one item from, above the input: typing filters it, Up and Down move, Enter picks,
 * Ctrl+F marks and Escape closes. Used by `/model` and `/sessions`.
 */

import { useBindings } from "@opentui/keymap/solid";
import { type Accessor, createMemo, createSignal, For, Show } from "solid-js";
import { PRIORITY } from "./keymap.ts";
import { COLORS } from "./theme.ts";

const SHOWN_ROWS = 10;

/** One choice in a picker: what it shows, what the filter matches, and what choosing it does. */
export type PickerItem = {
  readonly label: string;
  /** Shown muted in parentheses after the label. */
  readonly note: string;
  readonly search: string;
  readonly choose: () => void;
  /** What Ctrl+F does to the item, if anything. */
  readonly mark?: () => void;
};

/**
 * A list the user filters and picks one item from, such as the models for `/model`. A divider
 * separates its sections. The sections can change while the picker is open.
 */
export type PickerList = {
  readonly title: string;
  readonly sections: Accessor<readonly (readonly PickerItem[])[]>;
  /** The key hint for `PickerItem.mark`. */
  readonly markHint?: string;
};

/** A line of the list: an item, with its place among the items, or the divider between sections. */
type Row =
  | { readonly type: "item"; readonly item: PickerItem; readonly index: number }
  | { readonly type: "divider" };

export function Picker(props: { readonly picker: PickerList; readonly close: () => void }) {
  const list = filteredList(() => props.picker.sections());

  const choose = () => {
    const item = list.selectedItem();
    props.close();
    item?.choose();
  };

  pickerKeys(list, props.close);

  return (
    <box
      border
      borderColor={COLORS.accent}
      title={props.picker.title}
      bottomTitle={props.picker.markHint ?? ""}
      flexDirection="column"
    >
      <input focused placeholder="Type to filter" onInput={list.filterWith} onSubmit={choose} />
      <Show when={list.visible().length > 0}>
        <box height={1} />
        <For each={list.visible()}>
          {(row) =>
            row.type === "divider" ? (
              <box border={["top"]} borderColor={COLORS.muted} height={1} />
            ) : (
              <PickerRow item={row.item} isSelected={row.index === list.selected()} />
            )
          }
        </For>
      </Show>
    </box>
  );
}

/** Escape and Ctrl-C close the picker, Up and Down move, and Ctrl+F marks the chosen item. */
const pickerKeys = (list: FilteredList, close: () => void) => {
  useBindings(() => ({
    priority: PRIORITY.panel,
    commands: [
      { name: "picker.close", run: close },
      {
        name: "picker.up",
        run: () => {
          list.move(-1);
        },
      },
      {
        name: "picker.down",
        run: () => {
          list.move(1);
        },
      },
      {
        name: "picker.mark",
        run: () => {
          const mark = list.selectedItem()?.mark;
          if (mark === undefined) return false;
          mark();
        },
      },
    ],
    bindings: [
      { key: "escape", cmd: "picker.close" },
      { key: "ctrl+c", cmd: "picker.close" },
      { key: "up", cmd: "picker.up" },
      { key: "down", cmd: "picker.down" },
      { key: "ctrl+f", cmd: "picker.mark" },
    ],
  }));
};

/** The label, cut with an ellipsis when it is too long, and the note, which always shows. */
export function PickerRow(props: { readonly item: PickerItem; readonly isSelected: boolean }) {
  return (
    <box flexDirection="row" backgroundColor={props.isSelected ? COLORS.border : "transparent"}>
      <text
        wrapMode="none"
        truncate
        flexShrink={1}
        fg={props.isSelected ? COLORS.accent : COLORS.text}
      >
        {props.item.label}
      </text>
      <text wrapMode="none" flexShrink={0} fg={COLORS.muted}>
        {` (${props.item.note})`}
      </text>
    </box>
  );
}

type FilteredList = ReturnType<typeof filteredList>;

/**
 * The rows that match the filter, the cursor, and the rows in view. The cursor keeps its place when
 * the sections change, such as after Ctrl+F, so the list does not jump; it stays on the last item
 * when the list gets shorter.
 */
const filteredList = (sections: Accessor<readonly (readonly PickerItem[])[]>) => {
  const [filter, setFilter] = createSignal("");
  const [cursor, setCursor] = createSignal(0);

  const shown = createMemo(() =>
    sections().flatMap((section) => {
      const matches = matching(section, filter());
      return matches.length > 0 ? [matches] : [];
    }),
  );

  const items = createMemo(() => shown().flat());
  const rows = createMemo(() => rowsOf(shown()));
  const selected = () => Math.min(cursor(), items().length - 1);

  const cursorRow = () =>
    rows().findIndex((row) => row.type === "item" && row.index === selected());

  // The first row in view moves only as far as it must to keep the cursor in view.
  const top = createMemo((previous: number) => {
    const row = cursorRow();
    if (row < previous) return Math.max(row, 0);
    if (row >= previous + SHOWN_ROWS) return row - SHOWN_ROWS + 1;
    return Math.min(previous, Math.max(rows().length - SHOWN_ROWS, 0));
  }, 0);

  return {
    selected,
    selectedItem: () => items()[selected()],
    visible: () => rows().slice(top(), top() + SHOWN_ROWS),
    filterWith: (text: string) => {
      setFilter(text);
      setCursor(0);
    },
    move: (step: number) => {
      setCursor(Math.min(Math.max(selected() + step, 0), items().length - 1));
    },
  };
};

/** The sections as lines, with a divider between each two. */
const rowsOf = (sections: readonly (readonly PickerItem[])[]): readonly Row[] => {
  let index = 0;

  return sections.flatMap((section, place) => {
    const itemRows = section.map((item): Row => ({ type: "item", item, index: index++ }));
    return place === 0 ? itemRows : [{ type: "divider" } as const, ...itemRows];
  });
};

/** The items whose search text has every word of the filter, in any case. */
const matching = (items: readonly PickerItem[], filter: string) => {
  const words = filter
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");

  return items.filter((item) => {
    const text = item.search.toLowerCase();
    return words.every((word) => text.includes(word));
  });
};
