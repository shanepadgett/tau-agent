/**
 * The skill and instruction files a run could not use. The user sees each problem in the status
 * strip, since it changes what the model knows, until a later run reads the file again.
 */

import { Context, Effect, Ref } from "effect";
import type { Status } from "../../Status.ts";

export class FileProblems extends Context.Service<
  FileProblems,
  {
    /** Reports a problem with `what`, such as "the skill /a/b", in a sentence `text`. */
    readonly report: (what: string, text: string) => Effect.Effect<void>;
  }
>()("tau/core/FileProblems") {}

/** The problems of each run, and a way to show the ones found so far. */
export type RunFileProblems = {
  readonly problems: FileProblems["Service"];
  /** Shows the problems the run found so far, and clears those shown before that it did not find. */
  readonly show: Effect.Effect<void>;
};

const KEY_PREFIX = "files.";

type Problems = ReadonlyMap<string, string>;

/** Gives the start of each run's record; every run of every session shows its problems in `status`. */
export const makeFileProblems = (status: Status["Service"]) =>
  Ref.make<Problems>(new Map()).pipe(Effect.map((shown) => startRun(status, shown)));

/** `shown` holds the problems in `status` now, by what they are about. */
const startRun = Effect.fn("startRun")(function* (
  status: Status["Service"],
  shown: Ref.Ref<Problems>,
) {
  const found = yield* Ref.make<Problems>(new Map());

  const show = Effect.gen(function* () {
    const now = yield* Ref.get(found);
    const before = yield* Ref.getAndSet(shown, now);

    const gone = [...before.keys()].filter((what) => !now.has(what));
    yield* Effect.forEach(gone, (what) => status.clear(KEY_PREFIX + what));

    const changed = [...now].filter(([what, text]) => before.get(what) !== text);

    yield* Effect.forEach(changed, ([what, text]) =>
      status.set({ key: KEY_PREFIX + what, severity: "warning", text }, what),
    );
  });

  const problems = FileProblems.of({
    report: (what, text) => Ref.update(found, (map) => new Map(map).set(what, text)),
  });

  return { problems, show } satisfies RunFileProblems;
});
