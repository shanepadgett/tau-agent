/**
 * The pictures the user added to the input. Each shows in the text as `[Image N]`; the bytes wait
 * here until the text is sent, and a chip the user deleted drops its picture.
 */

import { fileURLToPath } from "node:url";
import { Effect, Option } from "effect";
import { createSignal } from "solid-js";
import { isImagePath } from "../../core/ImagePath.ts";

const CHIP = /\[Image (\d+)\]/g;

export type SentPictures = { readonly text: string; readonly images: readonly Uint8Array[] };

export const createPictures = () => {
  const added = new Map<number, Uint8Array>();
  let last = 0;

  const [named, setNamed] = createSignal<readonly string[]>([]);

  const known = (text: string) =>
    [...text.matchAll(CHIP)].filter((chip) => added.has(Number(chip[1])));

  return {
    /** Keeps the picture and gives the chip to put in the text. */
    add: (bytes: Uint8Array) => {
      last += 1;
      added.set(last, bytes);
      return `[Image ${last}]`;
    },
    /** Follows the input's text: the chips of it that name a picture, such as `Image 1`. */
    follow: (text: string) => {
      setNamed(known(text).map((chip) => chip[0].slice(1, -1)));
    },
    named,
    /**
     * The text with its chips numbered 1, 2, … in order, and the pictures they name. Chips of
     * pictures that are not here stay as plain text. Sending ends the pictures of the input.
     */
    take: (text: string): SentPictures => {
      const images: Uint8Array[] = [];

      const numbered = text.replace(CHIP, (chip, digits: string) => {
        const bytes = added.get(Number(digits));
        if (bytes === undefined) return chip;
        images.push(bytes);
        return `[Image ${images.length}]`;
      });

      added.clear();
      last = 0;
      return { text: numbered, images };
    },
  };
};

/**
 * The path of a picture file that a terminal pastes when the user drops the file on it: possibly
 * quoted, escaped with backslashes or a `file://` link. Nothing for any other text.
 */
export const droppedImagePath = (pasted: string) => {
  const text = pasted.trim();
  if (text === "" || text.includes("\n")) return Option.none();

  const quoted = /^(["'])(.*)\1$/.exec(text);
  const unquoted = quoted?.[2] ?? text.replace(/\\(.)/g, "$1");
  const path = unquoted.startsWith("file://") ? fileURLToPath(unquoted) : unquoted;
  return isImagePath(path) ? Option.some(path) : Option.none();
};

/** Reads a picture file; nothing when it cannot be read. */
export const readPictureFile = (path: string) =>
  Effect.tryPromise(() => Bun.file(path).bytes()).pipe(Effect.option);
