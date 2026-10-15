/**
 * The gallery's screen: groups and stories on the left, the chosen story on the right at the
 * chosen terminal size. Keys: arrows pick the group and the story, `s` the state, `z` the size,
 * `q` quits.
 */

import type { CliRenderer } from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider, useBindings } from "@opentui/keymap/solid";
import { render, useTerminalDimensions } from "@opentui/solid";
import { ErrorBoundary, For, Show } from "solid-js";
import { type GalleryState, galleryState } from "./gallery-state.ts";
import { STORIES } from "./stories.ts";
import { GROUPS, type StoryFill, type StoryState } from "./story.ts";

/** The gallery's own colors, so redesigning the app does not change the gallery. */
const CHROME = { text: "#dddddd", muted: "#888888", accent: "#61afef", error: "#e06c75" } as const;

const LIST_COLUMNS = 30;

/** The borders of the two panes take two columns each; the key hints take one row. */
const PANE_BORDER = 2;

/** The preview's border and the key hints. */
const PREVIEW_CHROME_ROWS = 3;

const HINTS = "↑↓ story   ←→ group   s state   z size   q quit";

export const showGallery = (renderer: CliRenderer) => {
  const keymap = createDefaultOpenTuiKeymap(renderer);

  return render(
    () => (
      <KeymapProvider keymap={keymap}>
        <Shell
          quit={() => {
            renderer.destroy();
          }}
        />
      </KeymapProvider>
    ),
    renderer,
  );
};

function Shell(props: { readonly quit: () => void }) {
  const gallery = galleryState(STORIES);
  galleryKeys(gallery, props.quit);

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexDirection="row" flexGrow={1}>
        <StoryList gallery={gallery} />
        <Preview gallery={gallery} />
      </box>
      <text fg={CHROME.muted}>{HINTS}</text>
    </box>
  );
}

const galleryKeys = (gallery: GalleryState, quit: () => void) => {
  useBindings(() => ({
    commands: [
      { name: "gallery.quit", run: quit },
      {
        name: "gallery.group.next",
        run: () => {
          gallery.moveGroup(1);
        },
      },
      {
        name: "gallery.group.previous",
        run: () => {
          gallery.moveGroup(-1);
        },
      },
      {
        name: "gallery.story.next",
        run: () => {
          gallery.moveStory(1);
        },
      },
      {
        name: "gallery.story.previous",
        run: () => {
          gallery.moveStory(-1);
        },
      },
      { name: "gallery.state.next", run: gallery.nextState },
      { name: "gallery.size.next", run: gallery.nextSize },
    ],
    bindings: [
      { key: "q", cmd: "gallery.quit" },
      { key: "ctrl+c", cmd: "gallery.quit" },
      { key: "right", cmd: "gallery.group.next" },
      { key: "left", cmd: "gallery.group.previous" },
      { key: "down", cmd: "gallery.story.next" },
      { key: "up", cmd: "gallery.story.previous" },
      { key: "s", cmd: "gallery.state.next" },
      { key: "z", cmd: "gallery.size.next" },
    ],
  }));
};

function StoryList(props: { readonly gallery: GalleryState }) {
  const title = () => {
    const group = props.gallery.group();
    return `${group.charAt(0).toUpperCase()}${group.slice(1)}`;
  };

  const hint = () => `←→ group · ${props.gallery.groupIndex() + 1}/${GROUPS.length}`;

  return (
    <box
      border
      borderColor={CHROME.muted}
      title={title()}
      bottomTitle={hint()}
      width={LIST_COLUMNS}
      flexShrink={0}
      flexDirection="column"
    >
      <Show
        when={props.gallery.stories().length > 0}
        fallback={<text fg={CHROME.muted}>No stories yet</text>}
      >
        <For each={props.gallery.stories()}>
          {(story, index) => (
            <text fg={index() === props.gallery.storyIndex() ? CHROME.accent : CHROME.text}>
              {`${index() === props.gallery.storyIndex() ? "▸" : " "} ${story.title}`}
            </text>
          )}
        </For>
      </Show>
    </box>
  );
}

/** Where each fill puts a story inside the chosen size. */
type Placement = {
  readonly alignItems: "center" | "stretch";
  readonly justifyContent: "center" | "flex-start";
  readonly grow: 0 | 1;
};

const PLACEMENT: Record<StoryFill, Placement> = {
  content: { alignItems: "center", justifyContent: "center", grow: 0 },
  width: { alignItems: "stretch", justifyContent: "center", grow: 0 },
  both: { alignItems: "stretch", justifyContent: "flex-start", grow: 1 },
};

/** The story of one state, placed by its fill. A failure in the story shows as text. */
function Placed(props: { readonly state: StoryState }) {
  const placement = PLACEMENT[props.state.fill ?? "width"];

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      alignItems={placement.alignItems}
      justifyContent={placement.justifyContent}
    >
      <box flexDirection="column" flexGrow={placement.grow}>
        <ErrorBoundary
          // Solid gives the fallback an Error even when something else was thrown.
          fallback={(error: Error) => (
            <text fg={CHROME.error}>{`Story failed: ${error.message}`}</text>
          )}
        >
          {props.state.view()}
        </ErrorBoundary>
      </box>
    </box>
  );
}

function Preview(props: { readonly gallery: GalleryState }) {
  const terminal = useTerminalDimensions();

  const pane = () => ({
    width: terminal().width - LIST_COLUMNS - PANE_BORDER,
    height: terminal().height - PREVIEW_CHROME_ROWS,
  });

  const shown = () => ({
    width: Math.min(props.gallery.size().width, pane().width),
    height: Math.min(props.gallery.size().height, pane().height),
  });

  const isClipped = () =>
    shown().width < props.gallery.size().width || shown().height < props.gallery.size().height;

  const title = () => {
    const story = props.gallery.story();
    const state = props.gallery.state();
    return story === undefined || state === undefined ? "" : `${story.title} · ${state.name}`;
  };

  const sizeLine = () => {
    const { width, height } = props.gallery.size();
    const clipped = isClipped() ? ` · clipped to ${shown().width}x${shown().height}` : "";
    return `${width}x${height}${clipped}`;
  };

  return (
    <box
      border
      borderColor={CHROME.accent}
      title={sizeLine()}
      titleAlignment="right"
      bottomTitle={title()}
      flexGrow={1}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
    >
      <box width={shown().width} height={shown().height} flexShrink={0} overflow="hidden">
        <Show when={props.gallery.state()} keyed>
          {(state) => <Placed state={state} />}
        </Show>
      </box>
    </box>
  );
}
