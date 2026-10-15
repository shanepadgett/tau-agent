/**
 * The `/connect` dialog: the providers and whether each is signed in, the ways to sign in to one,
 * the sign-out question and a login in progress. It draws `ConnectState`; the flow changes it.
 */

import { useBindings } from "@opentui/keymap/solid";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import type { ConnectFlow } from "./connect-flow.ts";
import { type ConnectState, type Progress, isSignedIn, vendorOf } from "./connect-state.ts";
import { enterBindings, PRIORITY } from "./keymap.ts";
import { COLORS } from "./theme.ts";
import { ChoiceRow } from "./ui/components/ChoiceRow.tsx";
import { Dialog } from "./ui/primitives/Dialog.tsx";

// Wider than the rows, so the dialog does not change width from screen to screen.
const MIN_COLUMNS = 64;
const PROVIDERS_HINT = "enter choose · ctrl+d sign out · esc close";
const WAYS_HINT = "enter sign in · ctrl+d sign out · esc back";
const METHODS_HINT = "enter sign in · esc back";
const SIGN_OUT_HINT = "enter sign out · esc keep";

type Props = { readonly flow: ConnectFlow; readonly state: ConnectState };

const progressOf = (state: ConnectState): Progress | undefined =>
  state.screen.type === "login" ? state.screen.progress : undefined;

const hintOf = (state: ConnectState) => {
  const { screen } = state;
  if (screen.type === "providers") return PROVIDERS_HINT;
  if (screen.type === "ways") return WAYS_HINT;
  if (screen.type === "methods") return METHODS_HINT;
  if (screen.type === "signOut") return SIGN_OUT_HINT;
  return screen.progress.type === "failed" ? "enter retry · esc back" : "esc cancel";
};

const titleOf = (state: ConnectState) => {
  const { screen } = state;
  if (screen.type === "providers") return "Connect a provider";
  if (screen.type === "methods") return screen.way.title;
  return vendorOf(state)?.name ?? "Connect a provider";
};

/** Shows the dialog while the flow has a state. Not keyed: a keystroke changes the state, and the dialog must keep its text field. */
export function ConnectDialogHost(props: { readonly flow: ConnectFlow }) {
  return (
    <Show when={props.flow.state()}>
      {(state) => <ConnectDialog flow={props.flow} state={state()} />}
    </Show>
  );
}

function ConnectDialog(props: Props) {
  useConnectKeys(props);

  return (
    <Dialog
      minColumns={MIN_COLUMNS}
      title={titleOf(props.state)}
      hint={hintOf(props.state)}
      onClose={props.flow.close}
    >
      <Switch>
        <Match when={choicesOf(props.state)}>
          {(choices) => <Choices choices={choices().rows} cursor={choices().row} />}
        </Match>
        <Match when={props.state.screen.type === "signOut"}>
          <text fg={COLORS.text}>{signOutQuestion(props.state)}</text>
        </Match>
        <Match when={props.state.screen.type === "login"}>
          <LoginBody progress={progressOf(props.state)} />
        </Match>
      </Switch>
      <Show when={props.state.message}>
        {(message) => <text fg={COLORS.warning}>{message()}</text>}
      </Show>
    </Dialog>
  );
}

type Choice = { readonly label: string; readonly isSignedIn: boolean };

/** The rows of a list screen and the row under the cursor; null for the other screens. */
const choicesOf = (state: ConnectState) => {
  const { screen } = state;

  if (screen.type === "providers")
    return {
      row: screen.row,
      rows: state.vendors.map((vendor) => rowOf(vendor.name, vendor.state)),
    };

  if (screen.type === "ways")
    return {
      row: screen.row,
      rows: (vendorOf(state)?.ways ?? []).map((way) => rowOf(way.title, way.state)),
    };

  if (screen.type === "methods")
    return {
      row: screen.row,
      rows: screen.way.methods.map((method) => ({ label: method.title, isSignedIn: false })),
    };

  return null;
};

const rowOf = (label: string, state: Parameters<typeof isSignedIn>[0]): Choice => ({
  label,
  isSignedIn: isSignedIn(state),
});

function Choices(props: { readonly choices: readonly Choice[]; readonly cursor: number }) {
  return (
    <For each={props.choices}>
      {(choice, index) => (
        <ChoiceRow
          label={choice.label}
          isSignedIn={choice.isSignedIn}
          isSelected={index() === props.cursor}
        />
      )}
    </For>
  );
}

const signOutQuestion = (state: ConnectState) =>
  state.screen.type === "signOut" ? `Sign out of ${state.screen.way.provider.id}?` : "";

function LoginBody(props: { readonly progress: Progress | undefined }) {
  return (
    <Switch>
      <Match when={props.progress?.type === "working" && props.progress}>
        {(progress) => (
          <box flexDirection="column">
            <For each={progress().lines}>{(line) => <text fg={COLORS.text}>{line}</text>}</For>
            <text fg={COLORS.muted}>Waiting…</text>
          </box>
        )}
      </Match>
      <Match when={props.progress?.type === "asking" && props.progress}>
        {(progress) => <Question progress={progress()} />}
      </Match>
      <Match when={props.progress?.type === "failed" && props.progress}>
        {(progress) => <text fg={COLORS.error}>{progress().reason}</text>}
      </Match>
    </Switch>
  );
}

/** A question and a text field. */
function Question(props: { readonly progress: Extract<Progress, { type: "asking" }> }) {
  const [typed, setTyped] = createSignal("");

  return (
    <box flexDirection="column">
      <text fg={COLORS.text}>{props.progress.question}</text>
      <box>
        {/* OpenTUI's input cannot hide what is typed. For a secret its text is drawn in the
            background color, and bullets are drawn over it. */}
        <input
          focused
          textColor={props.progress.isSecret ? COLORS.background : COLORS.text}
          onInput={(text: string) => {
            setTyped(text);
          }}
          onSubmit={() => {
            props.progress.answer(typed());
          }}
        />
        <Show when={props.progress.isSecret}>
          <box position="absolute" top={0} left={0}>
            <text fg={COLORS.text}>{"•".repeat(typed().length)}</text>
          </box>
        </Show>
      </box>
    </box>
  );
}

const useConnectKeys = (props: Props) => {
  const isAsking = () => progressOf(props.state)?.type === "asking";

  // Escape and Ctrl-C work while a field has the keys; the rest would take its text.
  useBindings(() => ({
    priority: PRIORITY.dialog,
    commands: [
      {
        name: "connect.back",
        run: () => {
          props.flow.back();
        },
      },
    ],
    bindings: [
      { key: "escape", cmd: "connect.back" },
      { key: "ctrl+c", cmd: "connect.back" },
    ],
  }));

  useBindings(() => ({
    priority: PRIORITY.dialog,
    enabled: () => !isAsking(),
    commands: [
      {
        name: "connect.up",
        run: () => {
          props.flow.move(-1);
        },
      },
      {
        name: "connect.down",
        run: () => {
          props.flow.move(1);
        },
      },
      { name: "connect.choose", run: props.flow.choose },
      { name: "connect.signOut", run: props.flow.askSignOut },
    ],
    bindings: [
      { key: "up", cmd: "connect.up" },
      { key: "down", cmd: "connect.down" },
      ...enterBindings("connect.choose"),
      { key: "ctrl+d", cmd: "connect.signOut" },
    ],
  }));
};
