/**
 * The tool table: each tool the model can call, as the model sees it and as Tau runs it. The model
 * call takes its toolkit from the table, and each tool call finds its tool there by name.
 */

import { type Effect, type FileSystem, Option, type Schema } from "effect";
import { type Tool, Toolkit } from "effect/ai";
import type { ChildProcessSpawner } from "effect/process";
import type { Entry, ToolDetails } from "../../../session/Entry.ts";
import type { ToolCall } from "../loop/tool-history.ts";
import type { OutputFiles } from "../output/output-files.ts";

/** What the built-in tools reach the computer through. */
export type Platform =
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | OutputFiles;

/**
 * A tool as the model sees it: a name, a description and a JSON schema. Tau runs each call itself,
 * so the definition needs no handler and no services.
 */
type ToolDefinition = Tool.Tool<
  string,
  {
    readonly parameters: typeof Schema.Unknown;
    readonly success: typeof Schema.String;
    readonly failure: typeof Schema.Never;
    readonly failureMode: "error";
  }
>;

/** What one call gives back: the text the model reads, and what the result entry saves. */
export type ToolOutcome = {
  readonly text: string;
  readonly isFailure: boolean;
  readonly details: ToolDetails | undefined;
};

/**
 * `entries` are the session's entries before the call, including the results of earlier calls of
 * the same reply. A call never fails: what went wrong is a failed outcome the model reads.
 */
export type ModelTool<R> = {
  readonly definition: ToolDefinition;
  readonly call: (
    call: ToolCall,
    entries: readonly Entry[],
  ) => Effect.Effect<ToolOutcome, never, R>;
};

export const toolkit = <R>(tools: readonly ModelTool<R>[]) =>
  Toolkit.make(...tools.map((tool) => tool.definition));

export const toolNamed = <R>(tools: readonly ModelTool<R>[], name: string) =>
  Option.fromUndefinedOr(tools.find((tool) => tool.definition.name === name));

export const toolNames = <R>(tools: readonly ModelTool<R>[]) =>
  tools.map((tool) => tool.definition.name);
