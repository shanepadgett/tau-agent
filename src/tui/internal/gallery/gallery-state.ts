/**
 * What the gallery has selected: the group, the story, its state and the preview size. Changing
 * the group or the story starts the next level from its first choice.
 */

import { type Accessor, createMemo, createSignal } from "solid-js";
import { GROUPS, type Size, type Story, type StoryGroup, type StoryState } from "./story.ts";

export const SIZES = [
  { width: 50, height: 15 },
  { width: 80, height: 24 },
  { width: 120, height: 30 },
] as const satisfies readonly Size[];

export type GalleryState = {
  readonly group: Accessor<StoryGroup>;
  readonly groupIndex: Accessor<number>;
  /** The stories of the group. */
  readonly stories: Accessor<readonly Story[]>;
  readonly storyIndex: Accessor<number>;
  /** None while the group has no stories. */
  readonly story: Accessor<Story | undefined>;
  readonly state: Accessor<StoryState | undefined>;
  readonly size: Accessor<Size>;
  readonly moveGroup: (step: number) => void;
  readonly moveStory: (step: number) => void;
  readonly nextState: () => void;
  readonly nextSize: () => void;
};

/** `index` moved by `step` in a list of `length` items, wrapping at both ends. */
const wrap = (index: number, step: number, length: number) =>
  length === 0 ? 0 : (((index + step) % length) + length) % length;

export const galleryState = (all: readonly Story[]): GalleryState => {
  const [groupIndex, setGroupIndex] = createSignal(0);
  const [storyIndex, setStoryIndex] = createSignal(0);
  const [stateIndex, setStateIndex] = createSignal(0);
  const [sizeIndex, setSizeIndex] = createSignal(0);

  const group = () => GROUPS[groupIndex()] ?? GROUPS[0];
  const stories = createMemo(() => all.filter((story) => story.group === group()));
  const story = () => stories()[storyIndex()];

  return {
    group,
    groupIndex,
    stories,
    storyIndex,
    story,
    state: () => story()?.states[stateIndex()],
    size: () => SIZES[sizeIndex()] ?? SIZES[0],
    moveGroup: (step) => {
      setGroupIndex(wrap(groupIndex(), step, GROUPS.length));
      setStoryIndex(0);
      setStateIndex(0);
    },
    moveStory: (step) => {
      setStoryIndex(wrap(storyIndex(), step, stories().length));
      setStateIndex(0);
    },
    nextState: () => setStateIndex(wrap(stateIndex(), 1, story()?.states.length ?? 0)),
    nextSize: () => setSizeIndex(wrap(sizeIndex(), 1, SIZES.length)),
  };
};
