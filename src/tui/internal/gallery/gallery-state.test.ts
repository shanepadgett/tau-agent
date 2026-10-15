/**
 * The gallery's selection rules: which choice resets which, and how each wraps. A unit test because
 * the rules interact; the gallery itself has no flow test yet.
 */

import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { galleryState, SIZES } from "./gallery-state.ts";
import type { Story, StoryState } from "./story.ts";

const blank = (name: string): StoryState => ({ name, view: () => {} });

const story = (id: string, group: Story["group"], first: string, ...rest: string[]): Story => ({
  id,
  group,
  title: id,
  states: [blank(first), ...rest.map(blank)],
});

const STORIES = [
  story("panel", "primitives", "a", "b"),
  story("row", "primitives", "c"),
  story("strip", "components", "d"),
];

const inState = (check: (state: ReturnType<typeof galleryState>) => void) => {
  createRoot((dispose) => {
    check(galleryState(STORIES));
    dispose();
  });
};

test("starts on the first story of the first group", () => {
  inState((gallery) => {
    expect(gallery.group()).toBe("primitives");
    expect(gallery.groupIndex()).toBe(0);
    expect(gallery.story()?.id).toBe("panel");
    expect(gallery.state()?.name).toBe("a");
    expect(gallery.size()).toBe(SIZES[0]);
  });
});

test("stories and states wrap at both ends", () => {
  inState((gallery) => {
    gallery.moveStory(-1);
    expect(gallery.story()?.id).toBe("row");
    gallery.moveStory(1);
    expect(gallery.story()?.id).toBe("panel");
    gallery.nextState();
    gallery.nextState();
    expect(gallery.state()?.name).toBe("a");
  });
});

test("a new story starts from its first state", () => {
  inState((gallery) => {
    gallery.nextState();
    gallery.moveStory(1);
    expect(gallery.state()?.name).toBe("c");
  });
});

test("a new group starts from its first story, and a group without stories shows none", () => {
  inState((gallery) => {
    gallery.moveStory(1);
    gallery.moveGroup(1);
    expect(gallery.story()?.id).toBe("strip");
    gallery.moveGroup(1);
    expect(gallery.group()).toBe("screens");
    expect(gallery.story()).toBeUndefined();
    expect(gallery.state()).toBeUndefined();
    gallery.nextState();
    gallery.moveStory(1);
    expect(gallery.story()).toBeUndefined();
  });
});

test("the size cycles through the three sizes", () => {
  inState((gallery) => {
    gallery.nextSize();
    gallery.nextSize();
    expect(gallery.size()).toBe(SIZES[2]);
    gallery.nextSize();
    expect(gallery.size()).toBe(SIZES[0]);
  });
});
