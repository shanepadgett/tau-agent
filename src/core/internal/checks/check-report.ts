/** Saves a bounded rendering of check outcomes without collecting a second copy of the report. */

import { Effect } from "effect";
import type { CheckReport } from "../../../session/CheckReport.ts";
import { saveOutput } from "../output/output-files.ts";

type CheckOutcomes = Pick<CheckReport, "passed" | "failed">;

export const saveCheckReport = Effect.fn("saveCheckReport")(function* (outcomes: CheckOutcomes) {
  const saved = yield* saveOutput(reportParts(outcomes), "checks", "whole").pipe(
    Effect.map((output) => ({ ...outcomes, ...output })),
    Effect.catchTag("OutputUnavailable", (error) =>
      Effect.succeed({
        ...outcomes,
        failed: [...outcomes.failed, { name: "output storage", output: error.message }],
        text: error.message,
        output: undefined,
      }),
    ),
  );

  const report: CheckReport = saved;
  return report;
});

function* reportParts(outcomes: CheckOutcomes) {
  let separator = "";

  for (const name of outcomes.passed) {
    yield `${separator}Passed: ${name}`;
    separator = "\n\n";
  }

  for (const { name, output } of outcomes.failed) {
    yield `${separator}Failed: ${name}\n${output.trim()}`;
    separator = "\n\n";
  }
}
