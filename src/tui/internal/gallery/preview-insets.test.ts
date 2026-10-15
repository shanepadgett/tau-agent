/** The border texts at the widths where they stop fitting. */

import { expect, test } from "bun:test";
import { previewInsets } from "./preview-insets.ts";

const NAME = "Panel · Title and hint";
const FULL = "50x15 · clipped to 48x15";
const SHORT = "50x15";

/** Border widths where each rule starts to apply for this name and size. */
const WIDE = 80;
const NO_ROOM_FOR_NOTE = 44;
const NO_ROOM_FOR_NAME = 30;
const ONLY_CORNERS = 9;
const MIDDLE = 40;

test("both texts stay whole when the border is wide", () => {
  expect(previewInsets(WIDE, NAME, FULL, SHORT)).toEqual({ name: NAME, size: FULL });
});

test("the size drops its clipped note before the name is cut", () => {
  expect(previewInsets(NO_ROOM_FOR_NOTE, NAME, FULL, SHORT)).toEqual({ name: NAME, size: SHORT });
});

test("the name is cut with an ellipsis when the short size still leaves too little room", () => {
  expect(previewInsets(NO_ROOM_FOR_NAME, NAME, FULL, SHORT)).toEqual({
    name: "Panel · Title and h…",
    size: SHORT,
  });
});

test("no name fits on a very narrow border", () => {
  expect(previewInsets(ONLY_CORNERS, NAME, FULL, SHORT)).toEqual({ name: "", size: SHORT });
});

test("an empty name leaves the size alone", () => {
  expect(previewInsets(MIDDLE, "", FULL, SHORT)).toEqual({ name: "", size: FULL });
});
