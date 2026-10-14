/** The agent's checkpoint tool. Saves a handoff and the exact notes used without waiting for a model. */

import { Effect, Result, Schema } from "effect";
import { Tool } from "effect/ai";
import type { Entry, SessionId } from "../../../../session/Entry.ts";
import type { Notes } from "../../../../session/Notes.ts";
import type { ToolCall } from "../../loop/tool-history.ts";
import type { ModelTool, ToolOutcome } from "../../tools/model-tool.ts";
import { estimatedPromptTokens } from "./budget.ts";
import { summaryPrefix } from "./view.ts";

const MAX_HANDOFF_CHARACTERS = 24_000;

const Parameters = Schema.Struct({
  handoff: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_HANDOFF_CHARACTERS)),
});

export const checkpointTool = (session: SessionId, notes: Notes["Service"]): ModelTool<never> => ({
  definition: Tool.dynamic("checkpoint", {
    description:
      "Compact your context instantly from the saved background notes and memory, recent entries and your handoff. Call this tool alone. The handoff must state the goal, active work, decisions, blockers and exact next action, in at most 24000 characters. Old entries stay in storage; read the entries behind a note with tools.history in run.",
    parameters: Tool.getJsonSchemaFromSchema(Parameters),
    success: Schema.String,
  }).annotate(Tool.Strict, false),
  call: Effect.fn("checkpoint")(
    function* (call: ToolCall, entries: readonly Entry[]) {
      const parsed = Schema.decodeUnknownResult(Parameters)(call.params);

      if (Result.isFailure(parsed))
        return failedCheckpoint(`The checkpoint parameters are wrong: ${parsed.failure.message}`);

      const reply = entries.findLast(({ body }) => body.type === "assistant" && !body.interrupted);

      if (reply?.body.type !== "assistant")
        return failedCheckpoint("No reply holds this checkpoint call.");

      const calls = reply.body.parts.filter((part) => part.type === "tool-call");

      if (calls.length !== 1)
        return failedCheckpoint("Call checkpoint alone, without any other tool call in the reply.");

      const memory = (yield* notes.memories(session)).findLast(
        (saved) => saved.throughEntry < reply.number,
      );

      const saved = (yield* notes.list(session)).filter(
        (note) => note.number > (memory?.throughNote ?? 0) && note.through < reply.number,
      );

      return {
        text: "Checkpoint saved. Your next model call starts from your notes, recent entries and this handoff.",
        isFailure: false,
        details: {
          tool: "checkpoint" as const,
          handoff: parsed.success.handoff,
          memory: memory?.number,
          notes: saved.map((note) => note.number),
          noteTokens: estimatedPromptTokens(summaryPrefix(memory, saved)),
          tailFrom: (saved.at(-1)?.through ?? memory?.throughEntry ?? 0) + 1,
        },
      };
    },
    Effect.catch((error) =>
      Effect.succeed(
        failedCheckpoint(`Could not read checkpoint notes: ${error.path}. Try checkpoint again.`),
      ),
    ),
  ),
});

const failedCheckpoint = (text: string): ToolOutcome => ({
  text,
  isFailure: true,
  details: undefined,
});
