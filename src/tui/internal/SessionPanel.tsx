/**
 * The sidebar's panel: the context the session uses, its cost, the agent's commands and how far
 * compaction reaches. A plain first design, to change after people use it.
 */

import { For, Show } from "solid-js";
import type { ChatProcesses, ChatState, Usage } from "./chat-state.ts";
import { SIDEBAR_COLUMNS } from "./sidebar-state.ts";
import { COLORS } from "./theme.ts";

const BAR_CELLS = 20;
const TOKENS_PER_K = 1000;
const PERCENT = 100;

export function SessionPanel(props: {
  readonly chat: ChatState;
  /** The commands to list, which can be fewer than the chat's: ended ones leave after a while. */
  readonly processes: ChatProcesses;
  /** Transparent when docked; a drawer hides the chat under it. */
  readonly background: string;
}) {
  return (
    <box
      border
      borderColor={COLORS.border}
      title="Session"
      flexDirection="column"
      width={SIDEBAR_COLUMNS}
      height="100%"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.background}
    >
      <Section
        title="Context"
        lines={[contextText(props.chat.usage), cacheText(props.chat.usage)]}
      />
      <Section title="Cost" lines={[costText(props.chat.usage)]} />
      <Processes processes={props.processes} />
      <Section title="References" lines={referenceLines(props.chat.references)} />
      <Section title="Compaction" lines={compactionLines(props.chat)} />
    </box>
  );
}

function Section(props: { readonly title: string; readonly lines: readonly string[] }) {
  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={COLORS.text}>{props.title}</text>
      <For each={props.lines}>{(line) => <text fg={COLORS.muted}>{line}</text>}</For>
    </box>
  );
}

type ChatProcess = ChatProcesses[number];

/** Running commands first, then the ones that ended, newest first. A long list ends in a count. */
function Processes(props: { readonly processes: ChatProcesses }) {
  const ordered = () => [
    ...props.processes.filter(({ state }) => state.type === "running"),
    ...props.processes.filter(({ state }) => state.type !== "running").toReversed(),
  ];

  const more = () => ordered().length - MAX_PROCESS_LINES;

  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={COLORS.text}>Processes</text>
      <Show when={ordered().length > 0} fallback={<text fg={COLORS.muted}>None started</text>}>
        <For each={ordered().slice(0, MAX_PROCESS_LINES)}>
          {(process) => <ProcessLine process={process} />}
        </For>
        <Show when={more() > 0}>
          <text fg={COLORS.muted}>{`and ${more()} more`}</text>
        </Show>
      </Show>
    </box>
  );
}

/** Such as `● bun test --watch          running`, with the command cut to leave room for the state. */
function ProcessLine(props: { readonly process: ChatProcess }) {
  const state = () => stateText(props.process.state);
  const room = () => LINE_CELLS - MARK_CELLS - state().length - 1;

  return (
    <box flexDirection="row">
      <text fg={markColor(props.process.state)}>{`${markOf(props.process.state)} `}</text>
      <text fg={COLORS.muted} flexGrow={1}>
        {cut(props.process.command, room())}
      </text>
      <text fg={COLORS.muted}>{` ${state()}`}</text>
    </box>
  );
}

/** The border and the padding take one cell on each side. */
const FRAME_CELLS = 4;
const LINE_CELLS = SIDEBAR_COLUMNS - FRAME_CELLS;
const MARK_CELLS = 2;
const MAX_PROCESS_LINES = 8;

const stateText = (state: ChatProcess["state"]) => {
  switch (state.type) {
    case "running":
      return "running";
    case "exited":
      return `exited ${state.exitCode}`;
    case "killed":
      return "killed";
  }
};

const markOf = (state: ChatProcess["state"]) => (state.type === "running" ? "●" : "○");

const markColor = (state: ChatProcess["state"]) => {
  if (state.type === "running") return COLORS.success;
  return state.type === "exited" && state.exitCode === 0 ? COLORS.muted : COLORS.error;
};

const cut = (text: string, cells: number) =>
  text.length <= cells ? text : `${text.slice(0, Math.max(0, cells - 1))}…`;

/** The attached reference repositories, one per line. */
const referenceLines = (names: readonly string[]) =>
  names.length === 0 ? ["None attached"] : names;

/** How far the background notes reach, and how many times the model compacted its context. */
const compactionLines = (chat: ChatState) => {
  const checkpoints = chat.items.filter(
    (item) => item.kind === "tool" && item.name === "checkpoint" && item.status === "ok",
  ).length;

  return [
    chat.notesThrough === undefined ? "No notes yet" : `Notes cover entries 1–${chat.notesThrough}`,
    checkpoints === 0
      ? "Not compacted yet"
      : `Compacted ${checkpoints} ${checkpoints === 1 ? "time" : "times"}`,
  ];
};

const NO_CALL = "No model call yet";

/** The context of the latest call, out of the model’s limit. */
const contextText = (usage: Usage | undefined) => {
  if (usage === undefined) return NO_CALL;
  const share = usage.contextTokens === 0 ? 0 : usage.contextUsed / usage.contextTokens;
  const filled = Math.min(BAR_CELLS, Math.round(share * BAR_CELLS));
  const usedCells = "█".repeat(filled) + "░".repeat(BAR_CELLS - filled);
  const tokens = `${tokenText(usage.contextUsed)} / ${tokenText(usage.contextTokens)}`;
  return `${tokens}  ${usedCells}`;
};

const cacheText = (usage: Usage | undefined) => {
  if (usage === undefined) return "Cache hit: —";
  if (usage.cacheHitShare === undefined) return "Cache hit: unavailable";
  return `Cache hit: ${(usage.cacheHitShare * PERCENT).toFixed(1)}%`;
};

/** Such as `$0.04`, the cost of the session's calls so far. */
const costText = (usage: Usage | undefined) => {
  if (usage === undefined) return NO_CALL;
  return usage.cost === undefined ? "No price for this model" : `$${usage.cost.toFixed(2)}`;
};

/** A token count in thousands, such as `200k`. */
const tokenText = (tokens: number) => `${Math.round(tokens / TOKENS_PER_K)}k`;
