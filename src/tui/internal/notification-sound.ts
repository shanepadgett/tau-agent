/** Loads the bundled notification sound into a scoped native audio engine on first use. */

import { Audio } from "@opentui/core";
import { Effect, Queue } from "effect";
import soundPath from "../../../assets/sounds/notification.wav" with { type: "file" };

export const openNotificationSound = Effect.gen(function* () {
  const errors = yield* Queue.unbounded<Error>();

  const audio = yield* Effect.acquireRelease(
    Effect.try(() => {
      const engine = Audio.create({ autoStart: false });

      engine.on("error", (error: Error) => {
        Queue.offerUnsafe(errors, error);
      });

      return engine;
    }),
    (engine) =>
      Effect.sync(() => {
        engine.dispose();
      }),
  );

  yield* Effect.forkScoped(
    Effect.forever(
      Queue.take(errors).pipe(
        Effect.flatMap((error) => Effect.logWarning("Notification audio failed.", error)),
      ),
    ),
  );

  const bytes = yield* Effect.tryPromise(() => Bun.file(soundPath).arrayBuffer());

  const sound = yield* Effect.try(() => {
    const decoded = audio.loadSound(bytes);

    if (decoded === null) throw new Error("Could not decode the bundled notification sound.");

    return decoded;
  });

  const play = Effect.try(() => {
    if (!audio.isStarted() && !audio.start())
      throw new Error("No notification audio device is available.");

    if (audio.play(sound) === null) throw new Error("Could not play the notification sound.");
  });

  return { play };
});
