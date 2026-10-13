/**
 * When a failed model call is tried again: up to four times, after about 2, 4, 8 and 16 seconds,
 * or after the wait the provider asks for when it is longer.
 */

import { Duration, Effect, Schedule } from "effect";
import { AiError } from "effect/ai";
import type { AgentEvent } from "../../Client.ts";
import type { RunError } from "./run-context.ts";

const MAX_RETRIES = 4;
const FIRST_WAIT = Duration.seconds(2);

/** A provider that asks for a longer wait is not tried again, and the run says when to try. */
export const LONGEST_PROVIDER_WAIT = Duration.minutes(2);

/** True for errors that can pass, such as a rate limit or a dropped connection. */
const canRetry = (error: RunError) =>
  AiError.isAiError(error) &&
  error.isRetryable &&
  Duration.isLessThanOrEqualTo(providerWait(error), LONGEST_PROVIDER_WAIT);

const providerWait = (error: RunError) =>
  AiError.isAiError(error) ? (error.retryAfter ?? Duration.zero) : Duration.zero;

/** Tells clients before each wait, so a user sees why nothing happens. */
export const retrySchedule = (emit: (event: AgentEvent) => Effect.Effect<void>) =>
  Schedule.max([Schedule.exponential(FIRST_WAIT), Schedule.recurs(MAX_RETRIES)]).pipe(
    Schedule.jittered,
    Schedule.setInputType<RunError>(),
    Schedule.while(({ input }) => canRetry(input)),
    // Jitter gives parts of a millisecond. Whole milliseconds keep the clock, and so the times
    // saved on entries, in whole milliseconds.
    Schedule.modifyDelay(({ input, duration }) =>
      Effect.succeed(
        Duration.millis(Math.round(Duration.toMillis(Duration.max(duration, providerWait(input))))),
      ),
    ),
    Schedule.tap(({ input, attempt, duration }) =>
      emit({
        type: "retrying",
        attempt,
        seconds: Math.round(Duration.toSeconds(duration)),
        message: input.message,
      }),
    ),
  );
