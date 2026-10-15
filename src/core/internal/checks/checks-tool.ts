/**
 * The `checks` tool, which the model has only when the project has `check` commands. It runs the
 * checks that match the files the current run changed.
 */

import { Effect, Option, Schema } from "effect";
import { Tool } from "effect/ai";
import { type CheckReport, checkReportText, hasFailures } from "../../../session/CheckReport.ts";
import type { Entry } from "../../../session/Entry.ts";
import type { ToolCall } from "../loop/tool-history.ts";
import type { ModelTool, Platform } from "../tools/model-tool.ts";
import { changesSincePrompt } from "./check-history.ts";
import type { ProjectChecks } from "./checks-file.ts";
import { dueChecks, runChecks } from "./run-checks.ts";

/**
 * Written out because `Schema.Struct({})` becomes `{ not: { type: "null" } }`, and Anthropic needs
 * every tool's input to be `type: "object"`.
 */
const NO_PARAMETERS_JSON_SCHEMA = { type: "object", properties: {} };

const NOTHING_TO_CHECK = "No checks apply to the changes in this run.";

const FIX_AND_CHECK_AGAIN =
  "Fix the reported problems directly, then call checks again to verify before your final message. Ask the user only if fixing a failure needs a change to the checks themselves, such as their configuration, rules or suppressions.";

const CHECK_AGAIN_AFTER_EDIT = "If you change any file after this, call checks again.";

/** None when the project has only fixers, which Tau runs itself. */
export const checksTool = (checks: ProjectChecks): Option.Option<ModelTool<Platform>> =>
  checks.check.length === 0 ? Option.none() : Option.some(checksModelTool(checks));

const checksModelTool = (checks: ProjectChecks): ModelTool<Platform> => ({
  definition: Tool.dynamic("checks", {
    description: checksDescription(checks),
    parameters: NO_PARAMETERS_JSON_SCHEMA,
    success: Schema.String,
  }).annotate(Tool.Strict, false),

  call: Effect.fn("checksTool")(function* (_call: ToolCall, entries: readonly Entry[]) {
    const due = yield* dueChecks(checks.check, checks.root, changesSincePrompt(entries));
    const report = yield* runChecks(due);
    const text = due.length === 0 ? NOTHING_TO_CHECK : withNextStep(report);

    return {
      text,
      isFailure: hasFailures(report),
      details: { tool: "checks" as const, report, output: report.output },
    };
  }),
});

/** The report, then what the model does next. */
const withNextStep = (report: CheckReport) =>
  `${checkReportText(report)}\n\n${hasFailures(report) ? FIX_AND_CHECK_AGAIN : CHECK_AGAIN_AFTER_EDIT}`;

const checksDescription = (checks: ProjectChecks) =>
  [
    "Runs the project's checks on the files changed since the user's last message, and gives each check that passed and the output of each that failed. The checks are:",
    "",
    ...checks.check.map(({ name, details }) =>
      details === undefined ? `- ${name}` : `- ${name}: ${details}`,
    ),
    "",
    "Call it last: it is the final action before your final summary. A completed call counts as current whether the checks pass or fail. Any later call that can write, even one that changes nothing, makes the result stale; finish that work and call checks again. Fix failures yourself. Ask the user only if fixing a failure needs a change to the checks themselves, such as their configuration, rules or suppressions. Do not run these checks yourself in a script.",
  ].join("\n");
