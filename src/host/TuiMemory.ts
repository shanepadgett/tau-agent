/** Keeps what the chat in the terminal remembers in `~/.tau/tui.json`, such as `{"sidebar": "closed"}`. */

import { join } from "node:path";
import { Crypto, Effect, FileSystem, Layer, Schema } from "effect";
import { type SidebarChoice, TuiMemory, TuiMemoryError } from "../core/TuiMemory.ts";
import { TauHome } from "../database/TauHome.ts";
import { replaceFile } from "./internal/replace-file.ts";

const TUI_FILE = "tui.json";

const TuiJson = Schema.fromJsonString(
  Schema.Struct({ sidebar: Schema.optional(Schema.Literals(["open", "closed"])) }),
);

/** Keeps the memory in `tui.json` in Tau's home folder. */
export const tuiMemoryLayer = Layer.effect(
  TuiMemory,
  TauHome.use((home) => makeTuiMemory(home.directory)),
);

const makeTuiMemory = Effect.fn("makeTuiMemory")(function* (tauDirectory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const path = join(tauDirectory, TUI_FILE);

  // A missing or damaged file is not an error: the chat uses its defaults, and the next save
  // writes a good file.
  const read = fileSystem.readFileString(path).pipe(
    Effect.flatMap(Schema.decodeEffect(TuiJson)),
    Effect.orElseSucceed((): typeof TuiJson.Type => ({})),
  );

  const sidebar = read.pipe(Effect.map((memory): SidebarChoice => memory.sidebar ?? "open"));

  // It reads the file first, so the other things it remembers stay.
  const saveSidebar = (choice: SidebarChoice) =>
    read.pipe(
      Effect.flatMap((memory) => Schema.encodeEffect(TuiJson)({ ...memory, sidebar: choice })),
      Effect.flatMap((text) => replaceFile(tauDirectory, TUI_FILE, text)),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.mapError((cause) => new TuiMemoryError({ path, cause })),
    );

  return TuiMemory.of({ sidebar, saveSidebar });
});
