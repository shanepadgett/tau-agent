/** The picker that `/references` opens: the library of reference repositories, with the attached ones above the line. */

import { Effect } from "effect";
import { createSignal } from "solid-js";
import {
  type CloneProgress,
  type Reference,
  type ReferenceFailed,
  referenceNameOf,
  type References,
} from "../../core/References.ts";
import type { ChatAction } from "./chat-state.ts";
import type { PickerItem, PickerList } from "./Picker.tsx";

const UPDATE_CONCURRENCY = 4;
const TITLE = "References";

/** What the references picker acts on. */
export type ReferencesTarget = {
  readonly library: References["Service"];
  /** The names attached to the session now. */
  readonly attached: () => readonly string[];
  /** Saves the attached names in the background. */
  readonly attach: (names: readonly string[]) => void;
  readonly apply: (action: ChatAction) => void;
  /** Runs `effect` in the background. */
  readonly fork: (effect: Effect.Effect<void>) => void;
  /** Replaces the open picker. */
  readonly show: (picker: PickerList) => void;
};

/** The state every mode of the picker shares. */
type Panel = {
  readonly target: ReferencesTarget;
  readonly references: () => readonly Reference[];
  readonly notes: () => Readonly<Record<string, string>>;
  readonly unfinished: () => readonly string[];
  /** The names marked in the list; they start as the attached ones. */
  readonly marked: () => ReadonlySet<string>;
  readonly setMarked: (names: ReadonlySet<string>) => void;
  readonly setReferences: (references: readonly Reference[]) => void;
  readonly setNotes: (notes: Readonly<Record<string, string>>) => void;
  readonly setUnfinished: (names: readonly string[]) => void;
};

/** The picker on `initial`, the library as it is when the command runs. */
export const referencesPicker =
  (target: ReferencesTarget) =>
  (initial: readonly Reference[]): PickerList => {
    const [references, setReferences] = createSignal(initial);
    const [notes, setNotes] = createSignal<Readonly<Record<string, string>>>({});
    // Names of clones that are running or failed, which have no folder yet.
    const [unfinished, setUnfinished] = createSignal<readonly string[]>([]);

    const [marked, setMarked] = createSignal<ReadonlySet<string>>(new Set(target.attached()));

    const panel: Panel = {
      target,
      references,
      notes,
      unfinished,
      marked,
      setMarked,
      setReferences,
      setNotes,
      setUnfinished,
    };

    // Clones made before descriptions were saved get theirs in the background.
    target.fork(target.library.fetchDescriptions.pipe(Effect.andThen(refresh(panel))));

    return listPicker(panel);
  };

const setNote = (panel: Panel, name: string, note: string | undefined) => {
  const { [name]: _dropped, ...rest } = panel.notes();
  panel.setNotes(note === undefined ? rest : { ...rest, [name]: note });
};

const dropUnfinished = (panel: Panel, name: string) => {
  panel.setUnfinished(panel.unfinished().filter((each) => each !== name));
};

const refresh = (panel: Panel) =>
  panel.target.library.list.pipe(
    Effect.map((found) => {
      panel.setReferences(found);
    }),
  );

/** Every row: the library, and the clones that have no folder yet, by name. */
const rows = (panel: Panel) => {
  const named = new Set(panel.references().map(({ name }) => name));

  const pending = panel
    .unfinished()
    .flatMap((name) =>
      named.has(name) ? [] : [{ name, branch: undefined, description: undefined }],
    );

  return [...panel.references(), ...pending].toSorted((left, right) =>
    left.name.localeCompare(right.name),
  );
};

const isAttached = (panel: Panel, name: string) => panel.target.attached().includes(name);

/** Applies the marked names as the session's attached references, in the order of the list. */
const applyMarks = (panel: Panel, marked: ReadonlySet<string>) => {
  const names = rows(panel).flatMap(({ name }) => (marked.has(name) ? [name] : []));
  panel.target.attach(names);
};

/** Runs `action` on the reference `name`, and shows its failure on the row. */
const run = <A>(
  panel: Panel,
  name: string,
  action: Effect.Effect<A, ReferenceFailed>,
  {
    working = "…",
    done = () => {},
  }: { readonly working?: string; readonly done?: (value: A) => void } = {},
) => {
  setNote(panel, name, working);

  return action.pipe(
    Effect.map((value) => {
      setNote(panel, name, undefined);
      done(value);
    }),
    Effect.catchTag("ReferenceFailed", (error) =>
      Effect.sync(() => {
        setNote(panel, name, `! ${error.message}`);
      }),
    ),
  );
};

const rowItem = (panel: Panel, reference: Reference): PickerItem => ({
  id: reference.name,
  label: reference.name,
  detail: reference.description,
  search: reference.name,
  note: panel.notes()[reference.name] ?? reference.branch ?? "",
  choose: () => {},
  unmarkable: !panel.references().some(({ name }) => name === reference.name),
});

/** The attached rows, then the rest. */
const sections = (panel: Panel) => {
  const all = rows(panel);
  const attached = all.filter(({ name }) => isAttached(panel, name));
  const others = all.filter(({ name }) => !isAttached(panel, name));

  return [attached.map((each) => rowItem(panel, each)), others.map((each) => rowItem(panel, each))];
};

const showList = (panel: Panel) => {
  panel.target.show(listPicker(panel));
};

/** A mode that takes text: the input asks `question` and `submit` gets the answer. */
const askMode = (
  panel: Panel,
  question: string,
  hint: string,
  submit: (answer: string) => void,
): PickerList => ({
  title: TITLE,
  sections: () => [],
  placeholder: () => question,
  hint,
  submit,
  back: () => {
    showList(panel);
  },
  keepsOpen: true,
});

const progressText = ({ phase, percent }: CloneProgress) => {
  switch (phase) {
    case "receiving":
      return `↓ ${percent}%`;
    case "resolving":
      return `resolving ${percent}%`;
    case "updating":
      return `checkout ${percent}%`;
  }
};

const clone = (panel: Panel, url: string) => {
  const name = referenceNameOf(url);

  if (name === "") {
    panel.target.apply({
      type: "notice",
      text: "Could not find a name in that URL. Use a git URL such as https://github.com/owner/repo.",
    });

    return;
  }

  panel.setUnfinished([...panel.unfinished().filter((each) => each !== name), name]);

  const progress = (each: CloneProgress) =>
    Effect.sync(() => {
      setNote(panel, name, progressText(each));
    });

  panel.target.fork(
    run(panel, name, panel.target.library.clone(url, progress), {
      done: () => {
        dropUnfinished(panel, name);
      },
    }).pipe(Effect.andThen(refresh(panel))),
  );
};

const updateAll = (panel: Panel) => {
  const update = (name: string) =>
    run(panel, name, panel.target.library.update(name)).pipe(
      Effect.map(() => {
        if (panel.notes()[name] === undefined) setNote(panel, name, "✓");
      }),
    );

  panel.target.fork(
    Effect.forEach(
      panel.references().map(({ name }) => name),
      update,
      { concurrency: UPDATE_CONCURRENCY, discard: true },
    ),
  );
};

const branchMode = (
  panel: Panel,
  reference: Reference,
  branches: readonly string[],
): PickerList => {
  const switchTo = (branch: string) => {
    const switching = panel.target.library.switchBranch(reference.name, branch);
    panel.target.fork(run(panel, reference.name, switching).pipe(Effect.andThen(refresh(panel))));
    showList(panel);
  };

  return {
    title: `Branch of ${reference.name}`,
    sections: () => [
      branches.map((branch) => ({
        id: branch,
        label: branch,
        search: branch,
        note: branch === reference.branch ? "current" : "",
        choose: () => {
          switchTo(branch);
        },
      })),
    ],
    hint: "enter switch · esc back",
    back: () => {
      showList(panel);
    },
    keepsOpen: true,
  };
};

const chooseBranch = (panel: Panel, selected: PickerItem | undefined) => {
  const reference = panel.references().find(({ name }) => name === selected?.id);
  if (reference === undefined) return;

  const listing = panel.target.library.branches(reference.name);

  panel.target.fork(
    run(panel, reference.name, listing, {
      done: (branches) => {
        panel.target.show(branchMode(panel, reference, branches));
      },
    }),
  );
};

/** Takes `name` out of the marks and, if the session has it attached, off the session. */
const unmark = (panel: Panel, name: string) => {
  panel.setMarked(new Set([...panel.marked()].filter((each) => each !== name)));
  const attached = panel.target.attached();
  if (attached.includes(name)) panel.target.attach(attached.filter((each) => each !== name));
};

const deleteMode = (panel: Panel, name: string): PickerList =>
  askMode(panel, `Delete ${name} from disk? y / n`, "enter answer · esc back", (answer) => {
    showList(panel);
    if (!answer.trim().toLowerCase().startsWith("y")) return;
    unmark(panel, name);

    panel.target.fork(
      run(panel, name, panel.target.library.remove(name), {
        done: () => {
          dropUnfinished(panel, name);
        },
      }).pipe(Effect.andThen(refresh(panel))),
    );
  });

const addMode = (panel: Panel): PickerList =>
  askMode(panel, "Git URL", "enter clone · esc back", (url) => {
    clone(panel, url.trim());
    showList(panel);
  });

const openSelected = (panel: Panel, selected: PickerItem | undefined) => {
  if (selected === undefined) return;

  panel.target.fork(
    run(panel, selected.id, panel.target.library.open(selected.id), {
      working: selected.note,
    }),
  );
};

const listPicker = (panel: Panel): PickerList => ({
  title: TITLE,
  sections: () => sections(panel),
  placeholder: () =>
    rows(panel).length === 0 ? "No references. ^n adds one from a git URL." : "Type to filter",
  hint: "^n new · ^r branch · ^u pull · ^o open · ^x del",
  multi: {
    noun: "attached",
    marked: panel.marked,
    setMarked: panel.setMarked,
    confirm: (marked) => {
      applyMarks(panel, marked);
    },
  },
  actions: [
    {
      key: "ctrl+n",
      run: () => {
        panel.target.show(addMode(panel));
      },
    },
    {
      key: "ctrl+r",
      run: (selected) => {
        chooseBranch(panel, selected);
      },
    },
    {
      key: "ctrl+u",
      run: () => {
        updateAll(panel);
      },
    },
    {
      key: "ctrl+o",
      run: (selected) => {
        openSelected(panel, selected);
      },
    },
    {
      key: "ctrl+x",
      run: (selected) => {
        if (selected !== undefined) panel.target.show(deleteMode(panel, selected.id));
      },
    },
  ],
});
