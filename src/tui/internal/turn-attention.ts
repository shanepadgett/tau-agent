/** Maps live turn outcomes to attention requests, independently for each displayed session. */

import { Effect } from "effect";
import type { AgentEvent } from "../../core/Client.ts";
import type { Attention } from "../Notifications.ts";

/** History must not be passed to this listener. Cancellation and duplicate ends are silent. */
export const turnAttention = (attention: Pick<Attention, "request">) => {
  let run: "idle" | "running" = "idle";

  return (event: AgentEvent): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (event.type === "run-started") {
        run = "running";
        return Effect.void;
      }

      if (event.type !== "run-ended" || run === "idle") return Effect.void;

      run = "idle";
      if (event.reason === "cancelled") return Effect.void;

      return attention.request(event.reason === "failed" ? "Run failed" : "Response ready");
    });
};
