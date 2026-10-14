/** Exposes the raw model-visible messages behind notes to a run script. */

import { Tool, toolError } from "@opencode/codemode";
import { Effect, Schema } from "effect";
import type { SessionId } from "../../../session/Entry.ts";
import type { Sessions } from "../../../session/Sessions.ts";
import { transcript } from "../../../session/transcript.ts";

const EntryNumber = Schema.Int.check(Schema.isGreaterThan(0));
const Parameters = Schema.Struct({ from: EntryNumber, through: EntryNumber });

export const historyFunction = (session: SessionId, sessions: Sessions["Service"]) =>
  Tool.make({
    description:
      "Reads the full transcript of a stored entry range, inclusive. Use the entry numbers shown on a background note to recall its user and assistant messages, tool calls and tool results. Print only the relevant parts; run output limits still apply.",
    input: Parameters,
    output: Schema.String,
    execute: (input) =>
      sessions.entries(session, input.from - 1).pipe(
        Effect.map((entries) =>
          transcript(entries.filter((entry) => entry.number <= input.through)),
        ),
        Effect.mapError((error) =>
          toolError(`Could not read session history at ${error.path}. Try again.`),
        ),
      ),
  });
