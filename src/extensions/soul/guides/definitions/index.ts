import debug from "./debug.ts";
import implement from "./implement.ts";
import plan from "./plan.ts";
import review from "./review.ts";

export const guides = [plan, review, debug, implement] as const;
