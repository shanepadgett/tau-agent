/** Tells the model, once, that a command it left running has exited. */

import { Effect } from "effect";
import type { ProcessExit, ProcessSessions } from "../../../proc/ProcessSessions.ts";
import type { NudgeEntry } from "../../../session/Entry.ts";

const noticeText = ({ process, tail }: ProcessExit) =>
  [
    `Process session ${process.id} (\`${process.command}\`) exited${
      process.state.type === "exited" ? ` with code ${process.state.exitCode}` : ""
    }.`,
    tail === "" ? "It printed nothing." : `Its last output:\n${tail}`,
  ].join(" ");

/** One nudge for each command that exited by itself since the last model call. */
export const processNotices = (sessions: ProcessSessions) =>
  sessions.takeExits.pipe(
    Effect.map((exits) =>
      exits.map((exit): NudgeEntry => ({
        type: "nudge",
        key: `process:${exit.process.id}`,
        text: noticeText(exit),
      })),
    ),
  );
