/**
 * What the gallery shows: a story is one piece of the new front end, in each state the user
 * should approve.
 */

import type { JSX } from "@opentui/solid";

export const GROUPS = ["primitives", "components", "screens"] as const;

export type StoryGroup = (typeof GROUPS)[number];

/** A size in terminal columns and rows. */
export type Size = { readonly width: number; readonly height: number };

/**
 * How a state fills the chosen size. `width` spans the width and is centered up and down; `both`
 * fills the whole size; `content` is as big as its content and centered both ways.
 */
export type StoryFill = "width" | "both" | "content";

export type StoryState = {
  readonly name: string;
  /** `width` when absent. */
  readonly fill?: StoryFill;
  readonly view: () => JSX.Element;
};

export type Story = {
  readonly id: string;
  readonly group: StoryGroup;
  readonly title: string;
  readonly states: readonly [StoryState, ...StoryState[]];
};
