/**
 * The place `sidebar.right`: the session panel, docked beside the chat or as a drawer over it.
 * The key toggle slides it in and out; a change of mode on resize does not slide.
 */

import {
  createTimeline,
  getTimelineEngine,
  RGBA,
  type Renderable,
  type Timeline,
} from "@opentui/core";
import { useBindings } from "@opentui/keymap/solid";
import { useRenderer } from "@opentui/solid";
import { type Accessor, createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import type { ChatProcesses, ChatState } from "./chat-state.ts";
import { PRIORITY } from "./keymap.ts";
import { Place } from "./Place.tsx";
import { recentProcesses } from "./recent-processes.ts";
import { SessionPanel } from "./SessionPanel.tsx";
import { SIDEBAR_COLUMNS, type SidebarState } from "./sidebar-state.ts";
import { COLORS } from "./theme.ts";

const SLIDE_MILLISECONDS = 150;

/** How dark the dimmed chat under an open drawer is, from 0 to 255. */
const DIM_ALPHA = 150;

export function Sidebar(props: { readonly sidebar: SidebarState; readonly chat: ChatState }) {
  const shown = slide(props.sidebar);
  const processes = recentProcesses(() => props.chat.processes);
  drawerKeys(props.sidebar);

  return (
    <Place name="sidebar.right">
      <Show when={shown() > 0}>
        <Show
          when={props.sidebar.mode() === "docked"}
          fallback={<Drawer shown={shown} chat={props.chat} processes={processes()} />}
        >
          {/* The panel keeps its width and the column clips its left part, so it slides in. */}
          <box
            width={Math.round(shown() * SIDEBAR_COLUMNS)}
            flexShrink={0}
            flexDirection="row"
            justifyContent="flex-end"
            overflow="hidden"
          >
            <SessionPanel chat={props.chat} processes={processes()} background="transparent" />
          </box>
        </Show>
      </Show>
    </Place>
  );
}

function Drawer(props: {
  readonly shown: Accessor<number>;
  readonly chat: ChatState;
  readonly processes: ChatProcesses;
}) {
  let panel: Renderable | undefined;

  // `translateX` moves the drawn panel without a new layout of the chat under it.
  createEffect(() => {
    const offset = Math.round((1 - props.shown()) * SIDEBAR_COLUMNS);
    if (panel !== undefined) panel.translateX = offset;
  });

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      zIndex={1}
      alignItems="flex-end"
      backgroundColor={RGBA.fromInts(0, 0, 0, Math.round(props.shown() * DIM_ALPHA))}
    >
      <box
        ref={(element: Renderable) => {
          panel = element;
        }}
        height="100%"
      >
        <SessionPanel
          chat={props.chat}
          processes={props.processes}
          background={COLORS.background}
        />
      </box>
    </box>
  );
}

/**
 * How far the sidebar is in, from 0 to 1. Opening and closing ease over 150 ms; a change of mode
 * jumps, because the layout around the panel changes at the same time.
 */
const slide = (sidebar: SidebarState) => {
  const renderer = useRenderer();
  const [shown, setShown] = createSignal(sidebar.isOpen() ? 1 : 0);
  let playing: Timeline | undefined;

  const stop = () => {
    if (playing === undefined) return;
    playing.pause();
    // A destroyed renderer has let go of its timelines, and its engine cannot be reached.
    if (!renderer.isDestroyed) getTimelineEngine(renderer).unregister(playing);
    playing = undefined;
  };

  const animate = (to: number) => {
    stop();
    const progress = { shown: shown() };

    // The engine is in the middle of its update when the slide completes, so it lets go after.
    const finish = () => {
      queueMicrotask(stop);
    };

    const timeline = createTimeline(
      { duration: SLIDE_MILLISECONDS, autoplay: false, onComplete: finish },
      renderer,
    );

    timeline.add(progress, {
      shown: to,
      duration: SLIDE_MILLISECONDS,
      ease: "outQuad",
      onUpdate: () => setShown(progress.shown),
    });

    playing = timeline;
    timeline.play();
  };

  createEffect(
    on([sidebar.isOpen, sidebar.mode], ([isOpen, mode], previous) => {
      const to = isOpen ? 1 : 0;

      if (previous?.[1] === mode && !renderer.isDestroyed) animate(to);
      else {
        stop();
        setShown(to);
      }
    }),
  );

  onCleanup(stop);
  return shown;
};

/** Escape closes an open drawer before it can cancel a run. */
const drawerKeys = (sidebar: SidebarState) => {
  useBindings(() => ({
    priority: PRIORITY.drawer,
    enabled: () => sidebar.mode() === "drawer" && sidebar.isOpen(),
    commands: [{ name: "sidebar.close", run: sidebar.close }],
    bindings: [{ key: "escape", cmd: "sidebar.close" }],
  }));
};
