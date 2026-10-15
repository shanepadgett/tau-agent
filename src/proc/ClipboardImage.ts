/** Reads a picture from the system clipboard: Bun's reader on macOS and Windows, a command on Linux. */

import { Effect, Option } from "effect";

type Picture = Option.Option<Uint8Array>;

/** The first of these that is installed and finds a picture gives it. */
const LINUX_READERS = [
  ["wl-paste", "--type", "image/png"],
  ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"],
] as const;

const none: Picture = Option.none();

const fromCommand = (command: readonly string[]) =>
  Effect.tryPromise(() => {
    const child = Bun.spawn([...command], { stdout: "pipe", stderr: "ignore" });

    return new Response(child.stdout)
      .bytes()
      .then((bytes) =>
        child.exited.then((code): Picture =>
          code === 0 && bytes.length > 0 ? Option.some(bytes) : none,
        ),
      );
  }).pipe(Effect.orElseSucceed(() => none));

const fromLinux = Effect.gen(function* () {
  for (const command of LINUX_READERS) {
    const found = yield* fromCommand(command);
    if (Option.isSome(found)) return found;
  }

  return none;
});

const fromBun = Effect.sync(() => Bun.Image.fromClipboard()).pipe(
  Effect.flatMap((image) =>
    image === null
      ? Effect.succeed(none)
      : Effect.tryPromise(() =>
          image
            .png()
            .bytes()
            .then((bytes): Picture => Option.some(bytes)),
        ),
  ),
  Effect.orElseSucceed(() => none),
);

/** The clipboard's picture as PNG bytes, or nothing when it holds none or cannot be read. */
export const readClipboardImage: Effect.Effect<Picture> =
  process.platform === "linux" ? fromLinux : fromBun;
