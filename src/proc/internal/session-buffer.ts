/**
 * Keeps the first and the last part of a process session's output, and the place where the agent
 * last read. When output outgrows the capacity, the middle is dropped and the text says so.
 */

export type SessionBuffer = {
  readonly append: (text: string) => void;
  /** Characters received so far, including dropped ones. */
  readonly length: () => number;
  /** Where the next unread text starts. */
  readonly readOffset: () => number;
  /** The text from character `offset` on. A dropped middle shows as one marker line. */
  readonly textFrom: (offset: number) => string;
  /** The text not read before, and marks it read. */
  readonly takeUnread: () => string;
  readonly whole: () => string;
  /** The last `count` lines, or all the text when it has fewer. */
  readonly lastLines: (count: number) => string;
};

export const makeSessionBuffer = (capacity: number): SessionBuffer => {
  const half = Math.floor(capacity / 2);
  let head = "";
  let tail = "";
  let total = 0;
  let readTo = 0;

  const append = (text: string) => {
    total += text.length;
    const intoHead = text.slice(0, half - head.length);
    head += intoHead;
    tail = (tail + text.slice(intoHead.length)).slice(-half);
  };

  const textFrom = (offset: number) => {
    const tailStart = total - tail.length;
    if (offset >= tailStart) return tail.slice(offset - tailStart);

    const fromHead = offset < head.length ? head.slice(offset) : "";
    const dropped = tailStart - Math.max(offset, head.length);
    if (dropped <= 0) return fromHead + tail;

    return `${fromHead}\n[${dropped} characters of output were dropped here]\n${tail}`;
  };

  const takeUnread = () => {
    const text = textFrom(readTo);
    readTo = total;

    return text;
  };

  const lastLines = (count: number) =>
    (tail === "" ? head : tail).trimEnd().split("\n").slice(-count).join("\n");

  return {
    append,
    length: () => total,
    readOffset: () => readTo,
    textFrom,
    takeUnread,
    whole: () => textFrom(0),
    lastLines,
  };
};
