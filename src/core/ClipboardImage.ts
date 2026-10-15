/** The clipboard's picture as PNG bytes, or nothing when it holds none, for clients that let the user paste one. */

import { Effect, Option } from "effect";
import { readClipboardImage } from "../proc/ClipboardImage.ts";

export const clipboardPicture = readClipboardImage.pipe(Effect.map(Option.getOrUndefined));
