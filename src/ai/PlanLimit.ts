/** Reads a plan login's usage limit from a model error, so a client can say when the plan resets. */

import { type DateTime, Option, Schema } from "effect";
import { AiError } from "effect/ai";

/** A subscription plan, and the page that shows how much of it the user has used. */
export type Plan = { readonly name: string; readonly usagePage: string };

export type PlanLimit = {
  readonly plan: Plan;
  /** None when the provider did not say. */
  readonly resetAt: Option.Option<DateTime.Utc>;
};

/** The key of the plan in the error's metadata. */
export const PLAN_METADATA_KEY = "tauPlan";

const PlanMetadata = Schema.Struct({ name: Schema.String, usagePage: Schema.String });
const decodePlan = Schema.decodeUnknownOption(PlanMetadata);

/** The limit, when the error is a plan login's usage limit. Tau never retries these errors. */
export const planLimitOf = (error: AiError.AiError): Option.Option<PlanLimit> => {
  if (!(error.reason instanceof AiError.QuotaExhaustedError)) return Option.none();

  const { metadata, resetAt } = error.reason;

  return decodePlan(metadata[PLAN_METADATA_KEY]).pipe(
    Option.map((plan) => ({ plan, resetAt: Option.fromUndefinedOr(resetAt) })),
  );
};
