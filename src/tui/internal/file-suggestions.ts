/** The `@` list above the input: files, folders and references matching the tag at the cursor. Tab opens a row; Enter tags it. */

import { type Accessor, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type { TagSearch } from "../../core/FileTags.ts";
import type { ChatClient } from "./chat-client.ts";
import { type Completion, type SuggestionKeys, suggestionList } from "./suggestion-list.ts";
import { tagAt, tagText } from "../../core/TagText.ts";

/** How often the list asks again while the folder's first index builds. */
const INDEXING_POLL_MS = 200;

export type FileSuggestions = ReturnType<typeof fileSuggestions>;

export const fileSuggestions = (client: Pick<ChatClient, "findTags" | "choseTag">) => {
  const [input, setInput] = createSignal({ text: "", cursor: 0 });
  const tag = createMemo(() => tagAt(input().text, input().cursor));
  const query = createMemo(() => tag()?.query);
  const search = searchFollowing(query, client.findTags);

  const rows = createMemo(() => {
    const found = search();
    return found?.state === "ready" ? found.rows : [];
  });

  const list = suggestionList(rows);

  /** The latest answer; while the next one comes, the list keeps the one before. */
  const shown = () => (tag() !== undefined && !list.dismissed() ? search() : undefined);

  /** Tagging a row also tells file search the user chose it. */
  const completionFor = (key: "tab" | "return"): Completion | undefined => {
    const at = tag();
    const chosen = list.chosen();
    if (at === undefined || shown() === undefined || chosen === undefined) return undefined;

    const replace = (text: string): Completion => ({
      type: "replace",
      start: at.start,
      end: at.end,
      text,
    });

    if (key === "tab" && chosen.kind === "reference") return replace(`@${chosen.name}/`);
    if (key === "tab" && chosen.kind === "folder") return replace(tagText(chosen.path));
    if (chosen.kind === "reference") return replace(`${tagText(chosen.tag)} `);

    client.choseTag(at.query, chosen);
    return replace(`${tagText(chosen.tag, at.lines)} `);
  };

  const keys: SuggestionKeys = {
    kind: "files",
    completes: () => shown() !== undefined && list.chosen() !== undefined,
    move: list.move,
    dismiss: list.dismiss,
    completionFor,
  };

  return {
    ...keys,
    shown,
    query,
    selected: list.selected,
    isOpen: () => shown() !== undefined,
    setInput: (text: string, cursor: number) => {
      const before = input();
      if (before.text === text && before.cursor === cursor) return;
      setInput({ text, cursor });
      if (before.text !== text) list.reset();
    },
  };
};

/** The latest answer for the query; while the folder's first index builds, it asks again. */
const searchFollowing = (query: Accessor<string | undefined>, findTags: ChatClient["findTags"]) => {
  const [search, setSearch] = createSignal<TagSearch | undefined>();

  createEffect(
    on(query, (asked) => {
      if (asked === undefined) return;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const ask = () => {
        void findTags(asked).then((answer) => {
          // A later query owns the list; this answer is old.
          if (query() !== asked) return;
          setSearch(answer);
          if (answer.state === "indexing") timer = setTimeout(ask, INDEXING_POLL_MS);
        });
      };

      ask();

      onCleanup(() => {
        clearTimeout(timer);
      });
    }),
  );

  return search;
};
