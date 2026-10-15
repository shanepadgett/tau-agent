/** Opens a callable attention service for terminal banners and bundled sound playback. */

import type { CliRenderer } from "@opentui/core";
import { Context, Effect, Scope } from "effect";
import { openNotificationSound } from "./internal/notification-sound.ts";

export type NotificationOptions = {
  readonly enabled: boolean;
  readonly sound: boolean;
};

/** Tests replace native audio acquisition with a recording playback effect. */
export const NotificationAudio = Context.Reference("tau/tui/NotificationAudio", {
  defaultValue: () => openNotificationSound,
});

const INPUT_NEEDED = "Input needed";

export type Attention = {
  readonly request: (message: string) => Effect.Effect<void>;
  /**
   * Runs `waiting`, an effect that ends when the user answers, and requests attention when it
   * starts unless another such effect is already running. Wrap every input request in it,
   * whatever the request looks like.
   */
  readonly waitForUser: <A, E>(waiting: Effect.Effect<A, E>) => Effect.Effect<A, E>;
};

/** Requests use the current focus and settings; delivery failures are logged without failing the caller. */
export const openAttention = Effect.fn("openAttention")(function* (
  renderer: CliRenderer,
  options: NotificationOptions,
) {
  const scope = yield* Effect.scope;

  const openSound = yield* NotificationAudio;

  const sound = yield* Effect.cached(
    openSound.pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.catch((error) =>
        Effect.logWarning("Could not load notification audio.", error).pipe(
          Effect.as({ play: Effect.void }),
        ),
      ),
    ),
  );

  const play = Effect.flatMap(sound, (playback) => playback.play).pipe(
    Effect.catch((error) => Effect.logWarning("Could not play notification audio.", error)),
  );

  let focus: "unknown" | "focused" | "blurred" = "unknown";

  const onFocus = () => {
    focus = "focused";
  };

  const onBlur = () => {
    focus = "blurred";
  };

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      renderer.on("focus", onFocus);

      renderer.on("blur", onBlur);
    }),
    () =>
      Effect.sync(() => {
        renderer.off("focus", onFocus);

        renderer.off("blur", onBlur);
      }),
  );

  const request = (message: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (!options.enabled || renderer.isDestroyed) return Effect.void;

      const banner = focus === "blurred" ? showBanner(renderer, message) : Effect.void;

      return banner.pipe(Effect.andThen(options.sound ? play : Effect.void));
    });

  let waiting = 0;

  const waitForUser = <A, E>(answer: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.acquireUseRelease(
      Effect.suspend(() => {
        waiting += 1;
        return waiting === 1 ? request(INPUT_NEEDED) : Effect.void;
      }),
      () => answer,
      () =>
        Effect.sync(() => {
          waiting -= 1;
        }),
    );

  return { request, waitForUser } satisfies Attention;
});

const showBanner = (renderer: CliRenderer, message: string) =>
  Effect.try(() => {
    renderer.triggerNotification(message, "Tau");
  }).pipe(
    Effect.catch((error) => Effect.logWarning("Could not send a terminal notification.", error)),
  );
