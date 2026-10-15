/**
 * Whether the sidebar shows, and how: docked beside the chat when the terminal is wide enough,
 * or as a drawer over the chat when it is not.
 */

import { type Accessor, createEffect, createMemo, createSignal, on } from "solid-js";
import type { SidebarChoice } from "../../core/TuiMemory.ts";

export const SIDEBAR_COLUMNS = 42;

/** The narrowest chat that a docked sidebar leaves. */
const MIN_CHAT_COLUMNS = 80;

/** Docked takes columns from the chat; a drawer covers part of it. */
export type SidebarMode = "docked" | "drawer";

export type SidebarMemory = {
  /** The choice the user last made while the sidebar was docked. */
  readonly remembered: SidebarChoice;
  readonly save: (choice: SidebarChoice) => void;
};

export type SidebarState = {
  readonly mode: Accessor<SidebarMode>;
  readonly isOpen: Accessor<boolean>;
  readonly toggle: () => void;
  readonly close: () => void;
};

/**
 * The sidebar of a terminal `width` columns wide. A docked sidebar opens as the user last left it,
 * and only its choices are saved. A drawer starts closed.
 */
export const sidebarState = (width: Accessor<number>, memory: SidebarMemory): SidebarState => {
  let remembered = memory.remembered;

  const mode = createMemo((): SidebarMode =>
    width() >= SIDEBAR_COLUMNS + MIN_CHAT_COLUMNS ? "docked" : "drawer",
  );

  const startsOpen = () => mode() === "docked" && remembered === "open";
  const [isOpen, setOpen] = createSignal(startsOpen());

  // A docked sidebar that turns into a drawer would cover the chat, so it closes. It opens again
  // when the terminal is wide again, if the user left it open.
  createEffect(on(mode, () => setOpen(startsOpen()), { defer: true }));

  const toggle = () => {
    const next = !isOpen();
    setOpen(next);
    if (mode() === "drawer") return;
    remembered = next ? "open" : "closed";
    memory.save(remembered);
  };

  return { mode, isOpen, toggle, close: () => setOpen(false) };
};
