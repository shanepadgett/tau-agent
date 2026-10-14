/** The result of running a project's checks, and the text the model reads for it. */

import { Schema } from "effect";

export const CheckReport = Schema.Struct({
  passed: Schema.Array(Schema.String),
  failed: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      output: Schema.String,
      file: Schema.optional(Schema.String),
    }),
  ),
  text: Schema.String,
  output: Schema.optional(Schema.String),
});

export type CheckReport = typeof CheckReport.Type;

export const hasFailures = (report: CheckReport) => report.failed.length > 0;

export const checkReportText = (report: CheckReport) => report.text;
