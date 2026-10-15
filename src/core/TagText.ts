/** Reads and writes `@` tags in a message: the tag at the cursor, a new tag's text, and where each tag is. */

/** `@` then a quoted path or a path without spaces, with an optional line range. */
const TAG_PATH = /(?<=^|\s)@(?:"([^"\n]*)"|([^\s"]+))/g;

/** The tag at the cursor: where it is, the path typed after `@`, and its line range, such as `#L10-20`. */
export type TagAt = {
  readonly start: number;
  readonly end: number;
  readonly query: string;
  readonly lines: string | undefined;
};

/** `@` then a quoted path, closed or not yet, or a path without spaces, up to the cursor. */
const TAG_BEFORE_CURSOR = /(?:^|\s)@("[^"\n]*|[^\s"]*)$/;

/** The rest of a quoted tag after the cursor, and of a tag without quotes. */
const QUOTED_REST = /^[^"\n]*"?/;
const PLAIN_REST = /^\S*/;

const LINES = /#L\d+(?:-\d+)?$/;

/** Every whole tag, for coloring. */
const TAGS = /(?<=^|\s)@(?:"[^"\n]*"|[^\s"]+)/g;

/** A tag starts the text or follows a space, so `me@example.com` holds none. */
export const tagAt = (text: string, cursor: number): TagAt | undefined => {
  const before = TAG_BEFORE_CURSOR.exec(text.slice(0, cursor));
  if (before === null) return undefined;

  const typed = before[1] ?? "";
  const isQuoted = typed.startsWith('"');
  const rest = (isQuoted ? QUOTED_REST : PLAIN_REST).exec(text.slice(cursor))?.[0] ?? "";
  const start = cursor - typed.length - 1;
  const end = cursor + rest.length;
  const path = isQuoted ? (typed + rest).slice(1).replace(/"$/, "") : typed + rest;
  const lines = LINES.exec(path)?.[0];

  return {
    start,
    end,
    query: lines === undefined ? path : path.slice(0, -lines.length),
    lines,
  };
};

/** `@src/a.ts#L10-20`, or `@"docs/my notes.md"` for a path with spaces. */
export const tagText = (path: string, lines = "") => {
  const target = path + lines;
  return /\s/.test(target) ? `@"${target}"` : `@${target}`;
};

/** The start and end of each tag in `text`. */
export const tagRanges = (text: string) =>
  [...text.matchAll(TAGS)].map((match) => [match.index, match.index + match[0].length] as const);

/** The path of each tag in `text`, without its line range. */
export const tagPaths = (text: string) =>
  [...text.matchAll(TAG_PATH)].map((match) => (match[1] ?? match[2] ?? "").replace(LINES, ""));
