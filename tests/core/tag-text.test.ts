/**
 * Input texts with a cursor, marked `|`, and the tag the `@` list completes there. A unit test
 * because the rule has many input cases; the flow test in `tests/tui/` shows the list on screen.
 */

import { expect, test } from "bun:test";
import { tagAt, tagRanges, tagText } from "../../src/core/TagText.ts";

const at = (marked: string) => tagAt(marked.replace("|", ""), marked.indexOf("|"));

const cases: ReadonlyArray<readonly [string, string, ReturnType<typeof tagAt>]> = [
  ["a lone @ is an empty query", "@|", { start: 0, end: 1, query: "", lines: undefined }],
  ["after a space", "look at @src/t|", { start: 8, end: 14, query: "src/t", lines: undefined }],
  [
    "the cursor inside a tag takes the whole tag",
    "@sr|c/a.ts x",
    { start: 0, end: 9, query: "src/a.ts", lines: undefined },
  ],
  [
    "a line range is kept apart",
    "@a.ts#L10-20|",
    { start: 0, end: 12, query: "a.ts", lines: "#L10-20" },
  ],
  [
    "a quoted path holds spaces",
    '@"my no|',
    { start: 0, end: 7, query: "my no", lines: undefined },
  ],
  [
    "a closed quote ends the tag",
    '@"my no|tes.md" x',
    { start: 0, end: 14, query: "my notes.md", lines: undefined },
  ],
  ["an @ inside a word is no tag", "me@example|", undefined],
  ["a space after the tag ends it", "@a.ts |", undefined],
  ["no @ at all", "hello|", undefined],
];

for (const [name, marked, expected] of cases) {
  test(name, () => {
    expect(at(marked)).toEqual(expected);
  });
}

test("a tag is written with its lines, and quoted when it has spaces", () => {
  expect(tagText("src/a.ts")).toBe("@src/a.ts");
  expect(tagText("src/a.ts", "#L3")).toBe("@src/a.ts#L3");
  expect(tagText("docs/my notes.md")).toBe('@"docs/my notes.md"');
});

test("tags are found for coloring, quoted ones whole, and none inside words", () => {
  const text = 'see @a.ts and @"my notes.md", mail me@example.com\n@b/';

  expect(tagRanges(text).map(([start, end]) => text.slice(start, end))).toEqual([
    "@a.ts",
    '@"my notes.md"',
    "@b/",
  ]);
});
