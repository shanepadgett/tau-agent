/** Settings for the notes method. The host reads them; the context method uses them. */

import { Context, Schema } from "effect";

const PositiveTokens = Schema.Int.check(Schema.isGreaterThan(0));

export const CompactionSettings = Schema.Struct({
  method: Schema.optional(Schema.Literals(["notes", "off"])),
  budgetTokens: Schema.optional(PositiveTokens),
  notesStartTokens: Schema.optional(PositiveTokens),
});

export type CompactionSettings = typeof CompactionSettings.Type;

export class ContextSettings extends Context.Service<ContextSettings, CompactionSettings>()(
  "tau/core/ContextSettings",
) {}
