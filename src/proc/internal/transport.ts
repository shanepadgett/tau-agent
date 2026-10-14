/** What a process session needs from a running command, whether it runs on pipes or on a PTY. */

import type { Effect, Stream } from "effect";

export type Transport = {
  /** The command's output, stdout and stderr in order. It ends when the command closes them. */
  readonly output: Stream.Stream<Uint8Array>;
  readonly write: (text: string) => Effect.Effect<void>;
  readonly exitCode: Effect.Effect<number>;
  /** Kills the command and everything it started. Calling it again does nothing. */
  readonly kill: Effect.Effect<void>;
};

export type ShellStart = {
  readonly command: string;
  readonly directory: string;
};
