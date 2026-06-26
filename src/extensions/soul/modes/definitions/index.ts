import debug from "./debug-mode.ts";
import implement from "./implement-mode.ts";
import plan from "./plan-mode.ts";
import review from "./review-mode.ts";

export const modes = [plan, review, debug, implement] as const;
