/** Places full tool output in the operating system's temporary folder. */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { Layer } from "effect";
import { OutputFolder } from "../core/OutputFolder.ts";

export const outputFolderLayer = Layer.sync(OutputFolder, () => ({
  directory: join(tmpdir(), "tau"),
}));
