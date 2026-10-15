/** The chat's commands, such as `/model` and `/sessions`, and the picker they open. */

import { DateTime, Effect } from "effect";
import { createSignal } from "solid-js";
import type { Agent, OpenSession } from "../../core/Agent.ts";
import type { RunOptions } from "../../core/Client.ts";
import { type ChatAction, type ChatState, isIdle } from "./chat-state.ts";
import type { CommitFlow } from "./commit-flow.ts";
import type { CommandInfo } from "./command-suggestions.ts";
import { type ModelRef, modelPicker } from "./model-picker.ts";
import type { PickerItem, PickerList } from "./Picker.tsx";
import { type ReferencesTarget, referencesPicker } from "./references-picker.ts";

type SessionId = OpenSession["session"]["id"];

type ChatAgent = Pick<
  Agent["Service"],
  "sessions" | "models" | "favoriteModels" | "toggleFavoriteModel" | "references"
>;

type ListedSession = Effect.Success<ReturnType<ChatAgent["sessions"]>>[number];

/**
 * A command: what the suggestion list says it does, and doing it. A command that takes an argument
 * gets the text after its name; the others run only on their name alone.
 */
type ChatCommand = {
  readonly description: string;
  readonly run: (argument: string) => Effect.Effect<void>;
  /** Text after the name is its argument, which it may take or must take. */
  readonly argument?: "optional" | "required";
};

/** What the commands act on. */
export type CommandTarget = {
  readonly chat: ChatState;
  readonly apply: (action: ChatAction) => void;
  readonly agent: ChatAgent;
  readonly opened: OpenSession;
  readonly setModel: (ref: RunOptions["model"]) => void;
  readonly requestRestart: Effect.Effect<void>;
  /** Ends the chat to open `session`. */
  readonly open: (session: SessionId) => void;
  /** Ends the chat to open a new session. */
  readonly openNew: () => void;
  /** Runs `effect` in the background. */
  readonly fork: (effect: Effect.Effect<void>) => void;
  readonly commit: CommitFlow;
};

const BUSY = "Wait for the run to end, or cancel it, before you switch sessions.";
const BUSY_COMMIT = "Wait for the run to end, or cancel it, before you commit.";
const ISO_MINUTE_LENGTH = 16;

/** Returns a way to open a picker on what a list finds, or to say why it found nothing. */
const picking =
  (apply: CommandTarget["apply"], setPicker: (picker: PickerList) => void) =>
  <A, E extends { readonly path: string }>(
    list: Effect.Effect<A, E>,
    picker: (found: A) => PickerList,
  ) =>
    list.pipe(
      Effect.match({
        onFailure: (error) => {
          apply({ type: "notice", text: `Could not read ${error.path}.` });
        },
        onSuccess: (found) => {
          setPicker(picker(found));
        },
      }),
    );

/** Does `act` only when nothing runs or waits, and otherwise says so. */
const whenIdle = ({ chat, apply }: CommandTarget, act: () => void, busy = BUSY) => {
  if (isIdle(chat)) act();
  else apply({ type: "notice", text: busy });
};

const sessionPicker =
  (target: CommandTarget) =>
  (sessions: readonly ListedSession[]): PickerList => ({
    title: "Session",
    sections: () => [sessions.map((listed) => sessionItem(target, listed))],
  });

const sessionItem = (target: CommandTarget, listed: ListedSession): PickerItem => {
  const label = listed.firstPrompt ?? "(no prompt)";
  const isOpen = listed.id === target.opened.session.id;
  const note = isOpen ? "this session" : dateText(listed.updatedAt);

  return {
    id: listed.id,
    label,
    note,
    search: `${label} ${note}`,
    choose: () => {
      whenIdle(target, () => {
        target.open(listed.id);
      });
    },
  };
};

/** Saves a change to the favorites in the background, and says when saving fails. */
const favoriteSaver =
  ({ agent, apply, fork }: CommandTarget) =>
  (ref: ModelRef) => {
    fork(
      agent.toggleFavoriteModel(ref).pipe(
        Effect.catchTag("FavoriteModelsError", (error) =>
          Effect.sync(() => {
            apply({ type: "notice", text: `Could not save favorites to ${error.path}.` });
          }),
        ),
      ),
    );
  };

/** The `/model` picker for the chat. */
const modelPickerFor = (target: CommandTarget) =>
  modelPicker({
    apply: target.apply,
    setModel: target.setModel,
    saveFavorite: favoriteSaver(target),
  });

/** What the references picker acts on, from the chat. */
const referencesTarget = (
  target: CommandTarget,
  show: (picker: PickerList | undefined) => void,
): ReferencesTarget => ({
  library: target.agent.references,
  attached: () => target.chat.references,
  attach: (names) => {
    target.fork(
      target.opened.references.set(names).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            target.apply({
              type: "notice",
              text: `Could not save the attached references: ${error.message}`,
            });
          }),
        ),
      ),
    );
  },
  apply: target.apply,
  fork: target.fork,
  show,
});

/**
 * The commands by their text, their names and descriptions for the suggestion list, and the picker
 * the last one opened.
 */
export const chatCommands = (target: CommandTarget) => {
  const { chat, apply, agent, opened } = target;
  const [picker, setPicker] = createSignal<PickerList | undefined>();
  const pick = picking(apply, setPicker);

  // In alphabetical order, the order of the suggestion list.
  const commands: Readonly<Record<string, ChatCommand>> = {
    "/commit": {
      description: "Commit every change, after the checks pass",
      argument: "optional",
      run: (instruction) =>
        Effect.sync(() => {
          whenIdle(
            target,
            () => {
              target.commit.run(instruction);
            },
            BUSY_COMMIT,
          );
        }),
    },
    "/model": {
      description: "Change the model for this chat",
      run: () => pick(Effect.all([agent.models, agent.favoriteModels]), modelPickerFor(target)),
    },
    "/new": {
      description: "Start a new session in this folder",
      run: () =>
        Effect.sync(() => {
          whenIdle(target, target.openNew);
        }),
    },
    "/references": {
      description: "Attach reference repositories, and manage the library",
      run: () => pick(agent.references.list, referencesPicker(referencesTarget(target, setPicker))),
    },
    "/restart": {
      description: "Restart Tau into new code",
      run: () =>
        Effect.suspend(() => {
          if (!isIdle(chat)) apply({ type: "restart-waiting" });
          return target.requestRestart;
        }),
    },
    "/sessions": {
      description: "Open an earlier session of this folder",
      run: () => pick(agent.sessions(opened.session.directory), sessionPicker(target)),
    },
  };

  const closePicker = () => {
    setPicker(undefined);
  };

  const list = Object.entries(commands).map(([name, command]): CommandInfo => ({
    name,
    description: command.description,
    argument: command.argument ?? "none",
  }));

  return { run: commandRun(commands), list, picker, closePicker };
};

/**
 * Finds the command `text` runs: a command's name alone, or the name of one that takes an
 * argument, then a space and the argument. None for other text, which is a prompt.
 */
const commandRun =
  (commands: Readonly<Record<string, ChatCommand>>) =>
  (text: string): Effect.Effect<void> | undefined => {
    const [, name = "", argument = ""] = /^(\/\S+)(?:\s+([\s\S]*))?$/u.exec(text) ?? [];
    const command = commands[name];
    if (command === undefined) return undefined;
    if (argument.trim() !== "" && command.argument === undefined) return undefined;
    return command.run(argument.trim());
  };

/** The UTC date and minute, such as `2026-10-14 09:30`. */
const dateText = (date: DateTime.Utc) =>
  DateTime.formatIso(date).slice(0, ISO_MINUTE_LENGTH).replace("T", " ");
