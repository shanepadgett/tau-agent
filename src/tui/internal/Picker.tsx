/** A list to pick one item from, above the input, that can add keys of its own or turn the input into a question. */

import { useBindings } from "@opentui/keymap/solid";
import { type Accessor, createMemo, createSignal, For, Show } from "solid-js";
import { PRIORITY } from "./keymap.ts";
import { COLORS } from "./theme.ts";

const SHOWN_ROWS = 10;

/** The detail gives up its space before the label does. */
const DETAIL_SHRINK = 100;

/** One choice in a picker: what it shows, what the filter matches, and what choosing it does. */
export type PickerItem = {
  /** Names the item for the list's keys; it stays the same when the list changes. */
  readonly id: string;
  readonly label: string;
  /** Shown muted in parentheses after the label. */
  readonly note: string;
  /** Shown muted after the note on one line, cut with an ellipsis when the row is full. */
  readonly detail?: string | undefined;
  readonly search: string;
  readonly choose: () => void;
  /** In a multi-select list, whether the row cannot be marked, such as a clone still running. */
  readonly unmarkable?: boolean;
};

/**
 * Makes the list a multi-select. Tab marks the row and moves down, Shift+Tab marks it and moves up,
 * Ctrl+A marks every row the filter shows (or unmarks them when all are marked), and Enter gives the
 * marked ids to `confirm`. The marks belong to the caller, so they outlive the list.
 */
export type PickerMulti = {
  /** What the count under the list counts, such as `attached`. */
  readonly noun: string;
  readonly marked: Accessor<ReadonlySet<string>>;
  readonly setMarked: (marked: ReadonlySet<string>) => void;
  readonly confirm: (marked: ReadonlySet<string>) => void;
};

/** A key of one list. `selected` is the item under the cursor, if the filter leaves one. */
export type PickerAction = {
  /** A key as the key map writes it, such as `ctrl+f`. */
  readonly key: string;
  readonly run: (selected: PickerItem | undefined) => void;
};

/**
 * A list the user filters and picks one item from, such as the models for `/model`. A divider
 * separates its sections. The sections can change while the picker is open.
 */
export type PickerList = {
  readonly title: string;
  readonly sections: Accessor<readonly (readonly PickerItem[])[]>;
  readonly actions?: readonly PickerAction[];
  /** The line under the list, such as the keys. */
  readonly hint?: string;
  readonly multi?: PickerMulti;
  /** What the empty input says; the filter prompt by default. */
  readonly placeholder?: Accessor<string>;
  /**
   * Makes the input a question: Enter gives the text typed to `submit`, and the list shows no
   * filter. The list stays open.
   */
  readonly submit?: (text: string) => void;
  /** Escape calls this, if set, instead of closing the list. */
  readonly back?: () => void;
  /** Whether Enter on an item leaves the list open. */
  readonly keepsOpen?: boolean;
};

/** A line of the list: an item, with its place among the items, or the divider between sections. */
type Row =
  | { readonly type: "item"; readonly item: PickerItem; readonly index: number }
  | { readonly type: "divider" };

export function Picker(props: { readonly picker: PickerList; readonly close: () => void }) {
  const list = filteredList(() => props.picker.sections());

  const choose = () => {
    const { multi } = props.picker;
    const item = list.selectedItem();
    if (props.picker.keepsOpen !== true) props.close();

    if (multi === undefined) item?.choose();
    else multi.confirm(multi.marked());
  };

  const submit = () => {
    if (props.picker.submit === undefined) choose();
    else props.picker.submit(list.text());
  };

  pickerKeys(list, props.picker, props.close);

  return (
    <box
      border
      borderColor={COLORS.accent}
      title={titleOf(props.picker)}
      bottomTitle={hintOf(props.picker)}
      flexDirection="column"
    >
      <input
        focused
        placeholder={props.picker.placeholder?.() ?? "Type to filter"}
        onInput={list.filterWith}
        onSubmit={submit}
      />
      <Show when={list.visible().length > 0}>
        <box height={1} />
        <For each={list.visible()}>
          {(row) =>
            row.type === "divider" ? (
              <box border={["top"]} borderColor={COLORS.muted} height={1} />
            ) : (
              <PickerRow
                item={row.item}
                isSelected={row.index === list.selected()}
                mark={markOf(props.picker.multi, row.item)}
              />
            )
          }
        </For>
      </Show>
    </box>
  );
}

const MULTI_KEYS = "tab mark · enter ok";

/** The line under the list: the keys of a multi-select, then the list's own hint. */
const hintOf = (picker: PickerList) => {
  if (picker.multi === undefined) return picker.hint ?? "";
  return [MULTI_KEYS, picker.hint ?? ""].filter((part) => part !== "").join(" · ");
};

/** The title, with the count of marked rows in a multi-select. */
const titleOf = ({ title, multi }: PickerList) =>
  multi === undefined ? title : `${title} · ${multi.marked().size} ${multi.noun}`;

/** How a row shows its mark, or none in a list that is not a multi-select. */
const markOf = (multi: PickerMulti | undefined, item: PickerItem): RowMark => {
  if (multi === undefined) return "none";
  if (item.unmarkable === true) return "blocked";
  return multi.marked().has(item.id) ? "marked" : "unmarked";
};

/** Marks `items`, or unmarks them when every one is marked already. */
const toggleMarks = (multi: PickerMulti, items: readonly PickerItem[]) => {
  const ids = items.flatMap((item) => (item.unmarkable === true ? [] : [item.id]));
  const next = new Set(multi.marked());
  const allMarked = ids.every((id) => next.has(id));

  for (const id of ids) {
    if (allMarked) next.delete(id);
    else next.add(id);
  }

  multi.setMarked(next);
};

/** Marks the row under the cursor, then moves `step` rows. */
const markAndMove = (list: FilteredList, multi: PickerMulti, step: number) => {
  const item = list.selectedItem();
  if (item !== undefined) toggleMarks(multi, [item]);
  list.move(step);
};

/** The keys that mark rows, when the list is a multi-select. */
const multiKeys = (list: FilteredList, multi: PickerMulti | undefined) =>
  multi === undefined
    ? { commands: [], bindings: [] }
    : {
        commands: [
          {
            name: "picker.mark",
            run: () => {
              markAndMove(list, multi, 1);
            },
          },
          {
            name: "picker.markUp",
            run: () => {
              markAndMove(list, multi, -1);
            },
          },
          {
            name: "picker.markAll",
            run: () => {
              toggleMarks(multi, list.items());
            },
          },
        ],
        bindings: [
          { key: "tab", cmd: "picker.mark" },
          { key: "shift+tab", cmd: "picker.markUp" },
          { key: "ctrl+a", cmd: "picker.markAll" },
        ],
      };

/** Escape and Ctrl-C close the picker or go back, Up and Down move, and the list's own keys act. */
const pickerKeys = (list: FilteredList, picker: PickerList, close: () => void) => {
  const actions = picker.actions ?? [];
  const marking = multiKeys(list, picker.multi);

  useBindings(() => ({
    priority: PRIORITY.panel,
    commands: [
      { name: "picker.close", run: picker.back ?? close },
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
      ...marking.commands,
      ...actions.map((action) => ({
        name: `picker.${action.key}`,
        run: () => {
          action.run(list.selectedItem());
        },
      })),
    ],
    bindings: [
      { key: "escape", cmd: "picker.close" },
      { key: "ctrl+c", cmd: "picker.close" },
      { key: "up", cmd: "picker.up" },
      { key: "down", cmd: "picker.down" },
      ...marking.bindings,
      ...actions.map((action) => ({ key: action.key, cmd: `picker.${action.key}` })),
    ],
  }));
};

/** A row's mark: none outside a multi-select, and blocked for a row that cannot be marked. */
type RowMark = "none" | "marked" | "unmarked" | "blocked";

const MARK_TEXT: Readonly<Record<RowMark, string>> = {
  none: "",
  marked: "[x] ",
  unmarked: "[ ] ",
  blocked: "    ",
};

/** The label, cut with an ellipsis when it is too long, and the note, which always shows. */
export function PickerRow(props: {
  readonly item: Pick<PickerItem, "label" | "note" | "detail">;
  readonly isSelected: boolean;
  readonly mark?: RowMark;
}) {
  return (
    <box flexDirection="row" backgroundColor={props.isSelected ? COLORS.border : "transparent"}>
      <Show when={props.mark !== undefined && props.mark !== "none"}>
        <text wrapMode="none" flexShrink={0} fg={COLORS.muted}>
          {MARK_TEXT[props.mark ?? "none"]}
        </text>
      </Show>
      <text
        wrapMode="none"
        truncate
        flexShrink={1}
        fg={props.isSelected ? COLORS.accent : COLORS.text}
      >
        {props.item.label}
      </text>
      <Show when={props.item.note !== ""}>
        <text wrapMode="none" flexShrink={0} fg={COLORS.muted}>
          {` (${props.item.note})`}
        </text>
      </Show>
      <Show when={props.item.detail !== undefined && props.item.detail !== ""}>
        <text wrapMode="none" truncate flexShrink={DETAIL_SHRINK} fg={COLORS.muted}>
          {`  ${props.item.detail}`}
        </text>
      </Show>
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
    text: filter,
    items,
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
