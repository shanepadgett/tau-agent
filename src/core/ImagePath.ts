/** Tells which file names are pictures Tau can show to the model. */

import { extname } from "node:path";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

export const isImagePath = (path: string) => IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
