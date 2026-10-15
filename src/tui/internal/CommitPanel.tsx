/**
 * The `/commit` panel above the input: a spinner while checks run, the model plans and git
 * commits; the plan to approve, one line per commit; and the push question.
 */

import { useBindings } from "@opentui/keymap/solid";
import { type Accessor, createSignal, For, Match, onCleanup, type Setter, Switch } from "solid-js";
import type { CommitFlow, CommitStep } from "./commit-flow.ts";
import { enterBindings, PRIORITY } from "./keymap.ts";
import { PickerRow } from "./Picker.tsx";
import { COLORS } from "./theme.ts";

const SHOWN_ROWS = 10;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_MS = 80;
const PUSH_CHOICES = ["No, keep them local", "Yes, push"];

type PanelProps = { readonly flow: CommitFlow; readonly step: CommitStep };
type Step<T extends CommitStep["type"]> = Extract<CommitStep, { type: T }>;

/** The first plan line in view and the chosen push answer. */
type PanelView = {
  readonly top: Accessor<number>;
  readonly setTop: Setter<number>;
  readonly choice: Accessor<number>;
  readonly setChoice: Setter<number>;
};

export function CommitPanel(props: PanelProps) {
  const [top, setTop] = createSignal(0);
  const [choice, setChoice] = createSignal(0);
  panelKeys(props, { top, setTop, choice, setChoice });

  return (
    <box
      border
      borderColor={COLORS.accent}
      title={titleOf(props.step)}
      bottomTitle={hintOf(props.step)}
      flexDirection="column"
    >
      <Switch>
        <Match when={stepOf(props.step, "checking")} keyed>
          {(step) => <Working text="Running checks" note={String(step.count)} />}
        </Match>
        <Match when={stepOf(props.step, "planning")} keyed>
          {(step) => <Working text="Planning commits" note={step.model} />}
        </Match>
        <Match when={stepOf(props.step, "committing")} keyed>
          {(step) => (
            <Working text={`Committing ${step.index + 1} of ${step.count}`} note="hooks included" />
          )}
        </Match>
        <Match when={stepOf(props.step, "pushing")} keyed>
          {(step) => <Working text={`Pushing ${commitsText(step.count)}`} note={step.target} />}
        </Match>
        <Match when={stepOf(props.step, "review")} keyed>
          {(step) => <PlanLines step={step} top={top()} />}
        </Match>
        <Match when={stepOf(props.step, "push")}>
          <PushChoices choice={choice()} />
        </Match>
      </Switch>
    </box>
  );
}

const stepOf = <T extends CommitStep["type"]>(step: CommitStep, type: T) =>
  // SAFETY: the step's type is `type`, and `type` names exactly one member of the union.
  step.type === type ? (step as Step<T>) : undefined;

const titleOf = (step: CommitStep) => {
  if (step.type !== "push") return "Commit";
  return `Push ${commitsText(step.count)} to ${step.target}?`;
};

const hintOf = (step: CommitStep) => {
  if (step.type === "review") return "enter commit · esc cancel";
  if (step.type === "checking" || step.type === "planning") return "esc cancel";
  return "";
};

/**
 * Escape and Ctrl-C cancel; Enter answers, and does nothing while the panel works, so no prompt is
 * sent. Up and Down scroll the plan or move between the push answers.
 */
const panelKeys = (props: PanelProps, view: PanelView) => {
  useBindings(() => ({
    priority: PRIORITY.panel,
    commands: [
      { name: "commit.cancel", run: props.flow.cancel },
      {
        name: "commit.answer",
        run: () => {
          answer(props, view);
        },
      },
      {
        name: "commit.up",
        run: () => {
          move(props, view, -1);
        },
      },
      {
        name: "commit.down",
        run: () => {
          move(props, view, 1);
        },
      },
    ],
    bindings: [
      { key: "escape", cmd: "commit.cancel" },
      { key: "ctrl+c", cmd: "commit.cancel" },
      ...enterBindings("commit.answer"),
      { key: "up", cmd: "commit.up" },
      { key: "down", cmd: "commit.down" },
    ],
  }));
};

const answer = (props: PanelProps, view: PanelView) => {
  if (props.step.type === "review") props.flow.reply("yes");
  else if (props.step.type === "push") props.flow.reply(view.choice() === 1 ? "yes" : "no");
};

const move = (props: PanelProps, view: PanelView, step: number) => {
  if (props.step.type === "push") view.setChoice(Math.min(Math.max(view.choice() + step, 0), 1));
  else if (props.step.type === "review") {
    const last = Math.max(props.step.plan.length - SHOWN_ROWS, 0);
    view.setTop(Math.min(Math.max(view.top() + step, 0), last));
  }
};

/** One line per commit: its subject, cut with an ellipsis, and its file count. */
function PlanLines(props: { readonly step: Step<"review">; readonly top: number }) {
  return (
    <For each={props.step.plan.slice(props.top, props.top + SHOWN_ROWS)}>
      {(commit) => (
        <PickerRow
          item={{
            label: commit.message.split("\n")[0] ?? "",
            note: filesText(commit.files.length),
          }}
          isSelected={false}
        />
      )}
    </For>
  );
}

function PushChoices(props: { readonly choice: number }) {
  return (
    <For each={PUSH_CHOICES}>
      {(label, index) => (
        <text fg={index() === props.choice ? COLORS.accent : COLORS.text}>
          {index() === props.choice ? `› ${label}` : `  ${label}`}
        </text>
      )}
    </For>
  );
}

/** A spinner, what is going on, and a muted note in parentheses. */
function Working(props: { readonly text: string; readonly note: string }) {
  const [frame, setFrame] = createSignal(0);

  const timer = setInterval(() => {
    setFrame((frame() + 1) % SPINNER.length);
  }, SPINNER_MS);

  onCleanup(() => {
    clearInterval(timer);
  });

  return (
    <box flexDirection="row">
      <text wrapMode="none" flexShrink={0}>{`${SPINNER[frame()] ?? ""} ${props.text}`}</text>
      <text wrapMode="none" truncate flexShrink={1} fg={COLORS.muted}>
        {` (${props.note})`}
      </text>
    </box>
  );
}

const commitsText = (count: number) => (count === 1 ? "1 commit" : `${count} commits`);
const filesText = (count: number) => (count === 1 ? "1 file" : `${count} files`);
