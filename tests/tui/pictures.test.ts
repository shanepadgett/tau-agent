/** The pictures in the input: chips, numbering when sending, and dropped file paths. */

import { expect, test } from "bun:test";
import { Option } from "effect";
import { createPictures, droppedImagePath } from "../../src/tui/internal/pictures.ts";

const bytes = (value: number) => new Uint8Array([value]);

test("sending numbers the chips again in order and gives their pictures", () => {
  const pictures = createPictures();
  pictures.add(bytes(1));
  pictures.add(bytes(2));

  const sent = pictures.take("look at [Image 2] and that");
  expect(sent.text).toBe("look at [Image 1] and that");
  expect(sent.images).toEqual([bytes(2)]);
});

test("a chip with no picture stays plain text", () => {
  const pictures = createPictures();
  expect(pictures.take("see [Image 3]")).toEqual({ text: "see [Image 3]", images: [] });
});

test("the input starts again at Image 1 after a send", () => {
  const pictures = createPictures();
  pictures.add(bytes(1));
  pictures.take("[Image 1]");
  expect(pictures.add(bytes(2))).toBe("[Image 1]");
});

test("follow names only the chips that still have a picture", () => {
  const pictures = createPictures();
  pictures.add(bytes(1));
  pictures.add(bytes(2));
  pictures.follow("only [Image 2] is left");
  expect(pictures.named()).toEqual(["Image 2"]);
});

test("a dropped picture file is found through quotes, escapes and file links", () => {
  expect(droppedImagePath("/tmp/shot.png")).toEqual(Option.some("/tmp/shot.png"));
  expect(droppedImagePath("'/tmp/my shot.PNG'")).toEqual(Option.some("/tmp/my shot.PNG"));
  expect(droppedImagePath("/tmp/my\\ shot.jpg")).toEqual(Option.some("/tmp/my shot.jpg"));
  expect(droppedImagePath("file:///tmp/a%20b.webp")).toEqual(Option.some("/tmp/a b.webp"));
  expect(Option.isNone(droppedImagePath("/tmp/notes.txt"))).toBe(true);
  expect(Option.isNone(droppedImagePath("two\nlines.png"))).toBe(true);
});
