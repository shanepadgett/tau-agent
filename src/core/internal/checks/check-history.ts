/** Reads from a session's entries what the current run changed and what its checks reported. */

import { Option } from "effect";
import { type CheckReport, hasFailures } from "../../../session/CheckReport.ts";
import type { Changes, Entry } from "../../../session/Entry.ts";
import { sincePrompt } from "../loop/tool-history.ts";

const changesOf = ({ body }: Entry) =>
  body.type === "tool-result" && body.details?.tool === "run"
    ? Option.fromUndefinedOr(body.details.changes)
    : Option.none<Changes>();

const reportOf = ({ body }: Entry) => {
  if (body.type === "checks") return Option.some(body.report);

  if (body.type === "tool-result" && body.details?.tool === "checks")
    return Option.some(body.details.report);

  return Option.none<CheckReport>();
};

const hasChanges = (changes: Changes) => changes.type === "unknown" || changes.paths.length > 0;

/** What the scripts of the current run changed. One unknown change makes the whole run unknown. */
export const changesSincePrompt = (entries: readonly Entry[]): Changes => {
  const changes = sincePrompt(entries).flatMap((entry) => Option.toArray(changesOf(entry)));
  if (changes.some((change) => change.type === "unknown")) return { type: "unknown" };

  const paths = new Set(changes.flatMap((change) => (change.type === "files" ? change.paths : [])));
  return { type: "files", paths: [...paths].toSorted() };
};

/**
 * The checks are due when the run changed files and no report came after the last change. A report
 * that failed is not due again: the model saw it, and may stop to ask the user what to do.
 */
export const checksDue = (entries: readonly Entry[]) => {
  const run = sincePrompt(entries);
  const lastChange = run.findLastIndex((entry) => Option.exists(changesOf(entry), hasChanges));
  if (lastChange === -1) return false;

  const lastReport = run.findLastIndex((entry) => Option.isSome(reportOf(entry)));
  return lastReport < lastChange;
};

/** The checks that failed in the current run's latest report, or none. */
export const failingChecks = (entries: readonly Entry[]) => {
  const latest = sincePrompt(entries).findLast((entry) => Option.isSome(reportOf(entry)));
  const report = Option.flatMap(Option.fromUndefinedOr(latest), reportOf);

  return Option.match(report, {
    onNone: () => [],
    onSome: ({ failed }) => failed.map(({ name }) => name),
  });
};

/** How many times the current run's checks failed when Tau ran them itself. */
export const failedSettles = (entries: readonly Entry[]) =>
  sincePrompt(entries).filter(({ body }) => body.type === "checks" && hasFailures(body.report))
    .length;
