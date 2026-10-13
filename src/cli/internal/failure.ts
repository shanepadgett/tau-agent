/** Prints a failure in plain words and ends the command with a failing exit code. */

import { Console, Effect, Runtime, Schema } from "effect";

/** A failure already printed in plain words, so the runtime only sets the exit code. */
class ShownToUser extends Schema.TaggedError<ShownToUser>()("ShownToUser", {
  cause: Schema.Defect(),
}) {
  override readonly [Runtime.errorReported] = false;
}

export const showFailure = (failure: { readonly message: string }) =>
  Console.error(failure.message).pipe(
    Effect.andThen(Effect.fail(new ShownToUser({ cause: failure }))),
  );
