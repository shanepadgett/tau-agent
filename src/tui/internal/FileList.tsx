/**
 * The `@` list above the input: matching files, folders and reference repositories, each with an
 * icon for its kind, or a line that says why there are none. The chosen row has a `▸`.
 */

import { type Accessor, For, Match, Show, Switch } from "solid-js";
import type { TagRow, TagSearch } from "../../core/FileTags.ts";
import type { FileSuggestions } from "./file-suggestions.ts";
import { COLORS } from "./theme.ts";

const ICONS = { file: "📄", folder: "📁", reference: "📚" } as const;

const REFERENCE_LABEL = "reference";

/** The border, the `▸` with its space, the icon, which is two columns wide, and its space. */
const ROW_FRAME = 7;

const OFF_TEXT: Record<Extract<TagSearch, { state: "off" }>["reason"], string> = {
  home: "File search is off in your home folder",
  root: "File search is off at the file system root",
  unavailable: "File search could not start here. Tau's log says why",
};

export function FileList(props: {
  readonly suggestions: FileSuggestions;
  /** The width of the list. */
  readonly columns: Accessor<number>;
}) {
  return (
    <Show when={props.suggestions.shown()} keyed>
      {(search) => (
        <box border borderColor={COLORS.accent} title="Files" flexDirection="column">
          <Switch>
            <Match when={search.state === "off" && search}>
              {(off) => <text fg={COLORS.muted}>{OFF_TEXT[off().reason]}</text>}
            </Match>
            <Match when={search.state === "indexing" && search}>
              {(indexing) => (
                <text fg={COLORS.muted}>
                  {`Indexing… ${indexing().scanned.toLocaleString("en-US")} files`}
                </text>
              )}
            </Match>
            <Match when={search.state === "ready" && search.rows.length === 0}>
              <text fg={COLORS.muted}>{`No files match "${props.suggestions.query() ?? ""}"`}</text>
            </Match>
            <Match when={search.state === "ready" && search}>
              {(ready) => (
                <For each={ready().rows}>
                  {(row, index) => (
                    <FileRow
                      row={row}
                      isChosen={index() === props.suggestions.selected()}
                      columns={props.columns()}
                    />
                  )}
                </For>
              )}
            </Match>
          </Switch>
        </box>
      )}
    </Show>
  );
}

function FileRow(props: {
  readonly row: TagRow;
  readonly isChosen: boolean;
  readonly columns: number;
}) {
  const path = () => (props.row.kind === "reference" ? `${props.row.name}/` : props.row.path);
  const label = () => (props.row.kind === "reference" ? REFERENCE_LABEL : "");
  const room = () => props.columns - ROW_FRAME - (label() === "" ? 0 : label().length + 1);

  return (
    <box flexDirection="row" justifyContent="space-between">
      <text wrapMode="none" fg={props.isChosen ? COLORS.accent : COLORS.text}>
        {`${props.isChosen ? "▸" : " "} ${ICONS[props.row.kind]} ${cutMiddle(path(), room())}`}
      </text>
      <text fg={COLORS.muted}>{label()}</text>
    </box>
  );
}

/** `src/tui/…/Input.tsx`: the start and the end of a path stay, as they tell most. */
const cutMiddle = (path: string, width: number) => {
  if (path.length <= width) return path;
  const kept = Math.max(width - 1, 2);
  const head = Math.ceil(kept / 2);
  return `${path.slice(0, head)}…${path.slice(path.length - (kept - head))}`;
};
