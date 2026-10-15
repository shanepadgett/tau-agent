/** The problems that are true now, such as new code that does not build, until their source clears them. */

import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect";

export type Severity = "error" | "warning" | "info";

/** One problem. A source sets it again under the same `key` to change its text. */
export type Condition = {
  readonly key: string;
  readonly severity: Severity;
  readonly text: string;
};

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export class Status extends Context.Service<
  Status,
  {
    /** Adds the condition, or replaces the one with its key, and logs it with its full `detail`. */
    readonly set: (condition: Condition, detail: string) => Effect.Effect<void>;
    readonly clear: (key: string) => Effect.Effect<void>;
    /** The conditions now and after each change: errors, then warnings, then info. */
    readonly current: Stream.Stream<readonly Condition[]>;
  }
>()("tau/core/Status") {
  static readonly layer = Layer.effect(
    Status,
    Effect.gen(function* () {
      const conditions = yield* SubscriptionRef.make<readonly Condition[]>([]);

      return {
        set: (condition, detail) =>
          SubscriptionRef.update(conditions, (list) => withCondition(list, condition)).pipe(
            Effect.andThen(logCondition(condition, detail)),
          ),
        clear: (key) =>
          SubscriptionRef.update(conditions, (list) =>
            list.filter((condition) => condition.key !== key),
          ),
        current: SubscriptionRef.changes(conditions),
      };
    }),
  );
}

/** A condition keeps its place when it is set again; a new one goes after the others of its severity. */
const withCondition = (list: readonly Condition[], condition: Condition) => {
  const index = list.findIndex((old) => old.key === condition.key);
  const next = index === -1 ? [...list, condition] : list.with(index, condition);

  return next.toSorted(
    (first, second) => SEVERITY_ORDER[first.severity] - SEVERITY_ORDER[second.severity],
  );
};

const logCondition = (condition: Condition, detail: string) => {
  const log = { error: Effect.logError, warning: Effect.logWarning, info: Effect.logInfo }[
    condition.severity
  ];

  return log(condition.text, detail).pipe(Effect.annotateLogs({ condition: condition.key }));
};
