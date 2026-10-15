/** Labels text the harness wrote for the model, so the model does not take it for the user's words. */

export type ReminderKind =
  | "instructions"
  | "nudge"
  | "checks"
  | "run-failed"
  | "handoff"
  | "folder-listings"
  | "short-term-memory"
  | "long-term-memory";

export const reminder = (kind: ReminderKind, text: string) =>
  `<reminder kind="${kind}">\n${text}\n</reminder>`;
