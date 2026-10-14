/**
 * The `checks` tool, which the model has only when the project has `check` commands. It runs the
 * checks that match the files the current run changed.
 */

import { Effect, Option, Schema } from "effect";
import { Tool } from "effect/ai";
import { checkReportText, hasFailures } from "../../../session/CheckReport.ts";
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
    const text = due.length === 0 ? NOTHING_TO_CHECK : checkReportText(report);

    return {
      text,
      isFailure: hasFailures(report),
      details: { tool: "checks" as const, report, output: report.output },
    };
  }),
});

const checksDescription = (checks: ProjectChecks) =>
  [
    "Runs the project's checks on the files changed since the user's last message, and gives each check that passed and the output of each that failed. The checks are:",
    "",
    ...checks.check.map(({ name, details }) =>
      details === undefined ? `- ${name}` : `- ${name}: ${details}`,
    ),
    "",
    "Call it when your changes are done, before your final message. Do not run these checks yourself in a script.",
  ].join("\n");
