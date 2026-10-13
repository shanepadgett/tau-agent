/** The text a failed run shows. A plan limit or a long provider wait says when to try again. */

import { Cause, DateTime, Duration, Option } from "effect";
import { AiError } from "effect/ai";
import { type PlanLimit, planLimitOf } from "../../../ai/PlanLimit.ts";
import { LONGEST_PROVIDER_WAIT } from "../loop/retry.ts";

const resetFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });

export const failureText = <E>(cause: Cause.Cause<E>): string => {
  const error = Cause.squash(cause);
  if (AiError.isAiError(error)) return modelFailureText(error);
  return error instanceof Error ? error.message : String(error);
};

const modelFailureText = (error: AiError.AiError) => {
  const limit = planLimitOf(error);
  if (Option.isSome(limit)) return planLimitText(limit.value);

  const wait = error.retryAfter;

  if (wait !== undefined && Duration.isGreaterThan(wait, LONGEST_PROVIDER_WAIT)) {
    return `The provider limits requests and asks for a wait of ${Duration.format(wait)}. Try again after that.`;
  }

  return error.message;
};

const planLimitText = ({ plan, resetAt }: PlanLimit) =>
  [
    `Your ${plan.name} plan reached its usage limit.`,
    ...(Option.isSome(resetAt)
      ? [`It resets at ${resetFormat.format(DateTime.toDate(resetAt.value))}.`]
      : []),
    `Usage: ${plan.usagePage}`,
  ].join(" ");
