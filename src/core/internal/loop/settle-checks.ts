/**
 * Runs the project's checks when the model ends its turn with unchecked changes, and ends the run
 * when it stops on checks it saw fail.
 */

import { Effect, Option } from "effect";
import { hasFailures } from "../../../session/CheckReport.ts";
import type { Entry } from "../../../session/Entry.ts";
import {
  changesSincePrompt,
  checksDue,
  failedSettles,
  failingChecks,
} from "../checks/check-history.ts";
import type { ProjectChecks } from "../checks/checks-file.ts";
import { dueChecks, runChecks } from "../checks/run-checks.ts";
import type { Platform } from "../tools/model-tool.ts";
import { CONTINUE, endWith, type Operation, type RunContext } from "./run-context.ts";
import { needsReply } from "./tool-history.ts";

/** How many times failed checks go back to the model before the run ends. */
const MAX_SEND_BACKS = 3;

export const settleChecks =
  <R>(run: RunContext<R>): Operation<R | Platform> =>
  (entries) => {
    if (Option.isNone(run.checks) || needsReply(entries)) return Option.none();
    if (checksDue(entries)) return Option.some(settle(run, run.checks.value, entries));

    // The model saw the failure and ended its turn, such as to ask the user before a fix.
    const failing = failingChecks(entries);
    if (failing.length === 0) return Option.none();

    return Option.some(Effect.succeed(endWith({ reason: "checks-failed", checks: failing })));
  };

/** A failure goes back to the model a few times, then ends the run. */
const settle = Effect.fn("settleChecks")(function* <R>(
  run: RunContext<R>,
  checks: ProjectChecks,
  entries: readonly Entry[],
) {
  const due = yield* dueChecks(checks.check, checks.root, changesSincePrompt(entries));
  const checkNames = due.map(({ check }) => check.name);

  if (checkNames.length > 0) yield* run.emit({ type: "checks-started", checks: checkNames });
  const report = yield* runChecks(due);
  const failed = report.failed.map(({ name }) => name);
  if (checkNames.length > 0) yield* run.emit({ type: "checks-ended", failed });

  yield* run.sessions.append(run.session, [{ type: "checks", report }]);

  const isOutOfTries = hasFailures(report) && failedSettles(entries) >= MAX_SEND_BACKS;
  return isOutOfTries ? endWith({ reason: "checks-failed", checks: failed }) : CONTINUE;
});
