/**
 * The `/qna` panel above the input: one tab per question and an Additional Context tab. A select or
 * confirm tab is a list of options with notes; an input tab and the typed-answer row take text.
 */

import { useBindings } from "@opentui/keymap/solid";
import { For, Match, Show, Switch, untrack } from "solid-js";
import { enterBindings, PRIORITY } from "./keymap.ts";
import type { QnaFlow } from "./qna-flow.ts";
import {
  acceptText,
  currentTab,
  dropNote,
  goTo,
  isAnsweredAt,
  isOtherRow,
  moveRow,
  noteText,
  optionDescription,
  optionLabels,
  pick,
  type Question,
  type QnaState,
  saveNote,
  startNote,
  type Tab,
  typeText,
} from "./qna-state.ts";
import { COLORS } from "./theme.ts";

type PanelProps = { readonly flow: QnaFlow; readonly state: QnaState };
type Choice = Extract<Tab, { type: "choice" }>;

const NAVIGATE_HINT = "enter pick · n note · ←→ tab · esc cancel";
const NOTE_HINT = "enter save note · esc drop note";
const OTHER_HINT = "enter save · esc drop · tab next";
const INPUT_HINT = "enter accept · tab next · esc cancel";
const CONTEXT_HINT = "enter send answers · tab next · esc cancel";

export function QnaPanel(props: PanelProps) {
  panelKeys(props);

  return (
    <box
      border
      borderColor={COLORS.accent}
      title="Questions"
      bottomTitle={hintOf(props.state)}
      flexDirection="column"
    >
      <Tabs state={props.state} />
      <box height={1} />
      {/* A new key per tab, so a text field starts from that tab's text. */}
      <For each={[props.state.tab]}>
        {() => (
          <Switch>
            <Match when={choiceOf(props.state)}>
              {(tab) => <ChoiceBody flow={props.flow} state={props.state} tab={tab()} />}
            </Match>
            <Match when={currentTab(props.state).type === "input"}>
              <TextBody flow={props.flow} state={props.state} />
            </Match>
            <Match when={currentTab(props.state).type === "context"}>
              <TextBody flow={props.flow} state={props.state} />
            </Match>
          </Switch>
        )}
      </For>
      <Show when={props.state.isIncomplete}>
        <text fg={COLORS.warning}>Answer every question before sending.</text>
      </Show>
    </box>
  );
}

const choiceOf = (state: QnaState) => {
  const tab = currentTab(state);
  return tab.type === "choice" ? tab : undefined;
};

const hintOf = (state: QnaState) => {
  const tab = currentTab(state);
  if (state.noting !== undefined) return NOTE_HINT;
  if (tab.type === "context") return CONTEXT_HINT;
  if (tab.type === "input") return INPUT_HINT;
  return isOtherRow(state) ? OTHER_HINT : NAVIGATE_HINT;
};

/** The tab names: the current one in brackets, answered ones with a check. */
function Tabs(props: { readonly state: QnaState }) {
  const names = () => [
    ...props.state.questions.map((_, index) => ({
      text: `${isAnsweredAt(props.state, index) ? "✓" : ""}${index + 1}`,
    })),
    { text: "Context" },
  ];

  return (
    <box flexDirection="row" gap={1}>
      <For each={names()}>
        {(name, index) => (
          <text fg={index() === props.state.tab ? COLORS.accent : COLORS.text}>
            {index() === props.state.tab ? `[${name.text}]` : name.text}
          </text>
        )}
      </For>
    </box>
  );
}

function ChoiceBody(props: {
  readonly flow: QnaFlow;
  readonly state: QnaState;
  readonly tab: Choice;
}) {
  const labels = () => optionLabels(props.tab.question);
  const isSelect = () => props.tab.question.kind === "select";

  return (
    <box flexDirection="column">
      <text>{props.tab.question.prompt}</text>
      <box height={1} />
      <For each={labels()}>
        {(label, index) => (
          <OptionRow
            flow={props.flow}
            state={props.state}
            tab={props.tab}
            label={label}
            index={index()}
          />
        )}
      </For>
      <Show when={isSelect()}>
        <OtherRow flow={props.flow} state={props.state} tab={props.tab} />
      </Show>
      <Show when={props.tab.question.recommendation !== undefined}>
        <box height={1} />
        <Recommendation question={props.tab.question} />
      </Show>
    </box>
  );
}

function OptionRow(props: {
  readonly flow: QnaFlow;
  readonly state: QnaState;
  readonly tab: Choice;
  readonly label: string;
  readonly index: number;
}) {
  const isUnderCursor = () => props.state.row === props.index;
  const description = () => optionDescription(props.tab.question, props.index);
  const note = () => props.tab.answer.notes[props.index];

  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={isUnderCursor() ? COLORS.accent : COLORS.text}>
          {`${isUnderCursor() ? "› " : "  "}${props.label}`}
        </text>
        <Show when={description() !== undefined}>
          <text fg={COLORS.muted}>{` (${description()})`}</text>
        </Show>
        <Show when={props.tab.answer.picked === props.index}>
          <text fg={COLORS.success}> ✓</text>
        </Show>
      </box>
      <Show
        when={props.state.noting === props.index}
        fallback={
          <Show when={note() !== undefined}>
            <text fg={COLORS.muted}>{`  └─ ${note()}`}</text>
          </Show>
        }
      >
        <box flexDirection="row">
          <text fg={COLORS.muted}> └─ </text>
          <NoteField flow={props.flow} state={props.state} />
        </box>
      </Show>
    </box>
  );
}

/** A label in the normal color and its value muted, so the value does not pull the eye. */
function LabeledLine(props: { readonly label: string; readonly value: string }) {
  return (
    <box flexDirection="row" gap={1}>
      <text flexShrink={0}>{props.label}</text>
      <text fg={COLORS.muted}>{props.value}</text>
    </box>
  );
}

/** The model's suggested answer and why; nothing when the question has none. */
function Recommendation(props: { readonly question: Question }) {
  return (
    <Show when={props.question.recommendation} keyed>
      {(recommendation) => (
        <box flexDirection="column">
          <LabeledLine label="Recommendation:" value={recommendation.answer} />
          <LabeledLine label="Reason:" value={recommendation.reason} />
        </box>
      )}
    </Show>
  );
}

/** The one-line field under an option, starting from the option's saved note. */
function NoteField(props: { readonly flow: QnaFlow; readonly state: QnaState }) {
  let draft = untrack(() => noteText(props.state) ?? "");

  return (
    <input
      focused
      value={draft}
      onInput={(text: string) => {
        draft = text;
      }}
      onSubmit={() => {
        props.flow.update((state) => saveNote(state, draft));
      }}
    />
  );
}

/** The row for the user's own answer. Under the cursor it is a text field. */
function OtherRow(props: {
  readonly flow: QnaFlow;
  readonly state: QnaState;
  readonly tab: Choice;
}) {
  const typed = () => props.tab.answer.other;

  return (
    <Show
      when={isOtherRow(props.state)}
      fallback={
        <box flexDirection="row">
          <text fg={COLORS.text}>{`  ${typed() === "" ? "Other…" : typed()}`}</text>
          <Show when={props.tab.answer.picked === "other"}>
            <text fg={COLORS.success}> ✓</text>
          </Show>
        </box>
      }
    >
      <box flexDirection="row">
        <text fg={COLORS.accent}>› </text>
        <input
          focused
          placeholder="Other…"
          value={untrack(typed)}
          onInput={(text: string) => {
            props.flow.update((state) => typeText(state, text));
          }}
          onSubmit={() => {
            props.flow.update(acceptText);
          }}
        />
      </box>
    </Show>
  );
}

/** An input question, or Additional Context. */
function TextBody(props: { readonly flow: QnaFlow; readonly state: QnaState }) {
  const tab = () => currentTab(props.state);

  const prompt = () => {
    const current = tab();

    return current.type === "input"
      ? current.question.prompt
      : "Anything else the model should know? (optional)";
  };

  const inputQuestion = () => {
    const current = tab();
    return current.type === "input" ? current.question : undefined;
  };

  const text = () => {
    const current = tab();
    return current.type === "input" ? current.text : props.state.context;
  };

  return (
    <box flexDirection="column">
      <text>{prompt()}</text>
      <box height={1} />
      <Show when={inputQuestion()} keyed>
        {(question) => (
          <Show when={question.recommendation !== undefined}>
            <Recommendation question={question} />
            <box height={1} />
          </Show>
        )}
      </Show>
      <box flexDirection="row">
        <text fg={COLORS.accent}>{"> "}</text>
        <input
          focused
          value={untrack(text)}
          onInput={(value: string) => {
            props.flow.update((state) => typeText(state, value));
          }}
          onSubmit={() => {
            if (tab().type === "context") props.flow.send();
            else props.flow.update(acceptText);
          }}
        />
      </box>
    </box>
  );
}

/**
 * Escape and Ctrl-C drop the note being typed, the typed answer, or the whole panel, in that order.
 * Tab changes tab everywhere. Up and Down, Left and Right, Enter and `n` act only where no text
 * field has the keys: a text field keeps them for its own text.
 */
const panelKeys = (props: PanelProps) => {
  tabKeys(props);
  listKeys(props);
  navigateKeys(props);
};

/** Escape, Ctrl-C and the tab keys work in every state. */
const tabKeys = (props: PanelProps) => {
  const { update } = props.flow;

  useBindings(() => ({
    priority: PRIORITY.panel,
    commands: [
      { name: "qna.cancel", run: escape(props) },
      {
        name: "qna.nextTab",
        run: () => {
          update((state) => goTo(state, state.tab + 1));
        },
      },
      {
        name: "qna.previousTab",
        run: () => {
          update((state) => goTo(state, state.tab - 1));
        },
      },
    ],
    bindings: [
      { key: "escape", cmd: "qna.cancel" },
      { key: "ctrl+c", cmd: "qna.cancel" },
      { key: "tab", cmd: "qna.nextTab" },
      { key: "shift+tab", cmd: "qna.previousTab" },
    ],
  }));
};

/** Up and Down move the cursor on a select or confirm tab, including the typed-answer row. */
const listKeys = (props: PanelProps) => {
  const { update } = props.flow;

  const isList = () =>
    currentTab(props.state).type === "choice" && props.state.noting === undefined;

  useBindings(() => ({
    priority: PRIORITY.panel,
    enabled: isList,
    commands: [
      {
        name: "qna.up",
        run: () => {
          update((state) => moveRow(state, -1));
        },
      },
      {
        name: "qna.down",
        run: () => {
          update((state) => moveRow(state, 1));
        },
      },
    ],
    bindings: [
      { key: "up", cmd: "qna.up" },
      { key: "down", cmd: "qna.down" },
    ],
  }));
};

/** Where no text field has the keys: Enter picks, `n` opens a note, Left and Right change tab. */
const navigateKeys = (props: PanelProps) => {
  const { update } = props.flow;

  const isNavigating = () => {
    const { state } = props;
    return currentTab(state).type === "choice" && state.noting === undefined && !isOtherRow(state);
  };

  useBindings(() => ({
    priority: PRIORITY.panel,
    enabled: isNavigating,
    commands: [
      {
        name: "qna.pick",
        run: () => {
          update(pick);
        },
      },
      {
        name: "qna.note",
        run: () => {
          update(startNote);
        },
      },
      {
        name: "qna.left",
        run: () => {
          update((state) => goTo(state, state.tab - 1));
        },
      },
      {
        name: "qna.right",
        run: () => {
          update((state) => goTo(state, state.tab + 1));
        },
      },
    ],
    bindings: [
      ...enterBindings("qna.pick"),
      { key: "n", cmd: "qna.note" },
      { key: "left", cmd: "qna.left" },
      { key: "right", cmd: "qna.right" },
    ],
  }));
};

const escape = (props: PanelProps) => () => {
  const { state, flow } = props;

  if (state.noting !== undefined) flow.update(dropNote);
  else if (isOtherRow(state) && typedAnswer(state) !== "")
    flow.update((current) => typeText(current, ""));
  else flow.cancel();
};

const typedAnswer = (state: QnaState) => {
  const tab = currentTab(state);
  return tab.type === "choice" ? tab.answer.other : "";
};
