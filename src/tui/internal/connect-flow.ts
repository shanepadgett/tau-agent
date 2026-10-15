/**
 * `/connect` in the chat: lists the providers, signs in by the way the user picks and signs out. A
 * login asks and shows through the dialog instead of the terminal.
 */

import { Effect, Redacted } from "effect";
import { type Accessor, createSignal } from "solid-js";
import type {
  ConnectFailure,
  ConnectPrompt,
  Connections,
  ConnectVendor,
  ConnectWay,
} from "../../core/Connections.ts";
import type { ChatAction } from "./chat-state.ts";
import {
  backFrom,
  type ChosenMethod,
  type ConnectState,
  moveRow,
  type Progress,
  providersScreen,
  type Screen,
  vendorOf,
  wayToSignOut,
} from "./connect-state.ts";

export type ConnectTarget = {
  readonly connections: Connections["Service"];
  readonly apply: (action: ChatAction) => void;
  /** Runs `effect` in the background, and gives a way to stop it. */
  readonly start: (effect: Effect.Effect<void>) => () => void;
};

/** The dialog's state and the small moves on it. */
type Store = {
  readonly state: Accessor<ConnectState | undefined>;
  readonly open: (state: ConnectState) => void;
  readonly change: (update: (current: ConnectState) => ConnectState) => void;
  readonly goTo: (screen: Screen) => void;
  /** Says something under the list, such as why a key did nothing. */
  readonly say: (message: string) => void;
  readonly setProgress: (progress: Progress) => void;
  readonly addLine: (line: string) => void;
  /** Remembers how to stop the login in progress. */
  readonly trackLogin: (stop: (() => void) | undefined) => void;
  readonly close: () => void;
  readonly back: () => void;
};

const createStore = (): Store => {
  const [state, setState] = createSignal<ConnectState | undefined>();
  let stopLogin: (() => void) | undefined;

  const change: Store["change"] = (update) => {
    setState((current) => (current === undefined ? undefined : update(current)));
  };

  const endLogin = () => {
    stopLogin?.();
    stopLogin = undefined;
  };

  const close = () => {
    endLogin();
    setState(undefined);
  };

  return {
    state,
    open: setState,
    change,
    goTo: (screen) => {
      change((current) => ({ ...current, screen, message: undefined }));
    },
    say: (message) => {
      change((current) => ({ ...current, message }));
    },
    setProgress: (progress) => {
      change((current) =>
        current.screen.type === "login"
          ? { ...current, screen: { ...current.screen, progress } }
          : current,
      );
    },
    addLine: (line) => {
      change((current) => {
        const { screen } = current;
        if (screen.type !== "login") return current;

        const lines = screen.progress.type === "working" ? screen.progress.lines : [];
        const progress: Progress = { type: "working", lines: [...lines, line] };
        return { ...current, screen: { ...screen, progress } };
      });
    },
    trackLogin: (stop) => {
      stopLogin = stop;
    },
    close,
    /** Goes to the screen before this one; closes the dialog from the first. */
    back: () => {
      const current = state();
      if (current === undefined) return;

      endLogin();
      const screen = backFrom(current);

      if (screen === undefined) close();
      else change((latest) => ({ ...latest, screen, message: undefined }));
    },
  };
};

/** What a login asks, shown in the dialog. The host layer opens the browser. */
const promptFor = (store: Store, method: ChosenMethod): ConnectPrompt => {
  const ask = (question: string, options: { readonly isSecret: boolean }) =>
    Effect.callback<string>((resume) => {
      store.setProgress({
        type: "asking",
        question,
        isSecret: options.isSecret,
        answer: (text) => {
          store.setProgress({ type: "working", lines: [] });
          resume(Effect.succeed(text));
        },
      });
    });

  return {
    openBrowser: (url) =>
      Effect.sync(() => {
        store.addLine(`Open this address to log in:\n${url}`);
      }),
    show: (text) =>
      Effect.sync(() => {
        store.addLine(text);
      }),
    ask: (question) => ask(question, { isSecret: false }),
    askSecret: (question) =>
      ask(question, { isSecret: true }).pipe(Effect.map((text) => Redacted.make(text))),
    chooseMethod: () => Effect.succeed(method ?? "browser"),
  };
};

/** Reads the vendors again, keeping the screen. */
const refresh = (store: Store, target: ConnectTarget) => {
  target.start(
    target.connections.vendors.pipe(
      Effect.match({
        onFailure: () => {},
        onSuccess: (vendors) => {
          store.change((current) => ({ ...current, vendors }));
        },
      }),
    ),
  );
};

type SignIn = {
  readonly vendor: ConnectVendor;
  readonly way: ConnectWay;
  readonly method: ChosenMethod;
};

const signIn = (store: Store, target: ConnectTarget, { vendor, way, method }: SignIn) => {
  const progress: Progress = { type: "working", lines: [] };
  store.goTo({ type: "login", vendorId: vendor.id, way, method, progress });

  const login = target.connections.logIn(way, promptFor(store, method)).pipe(
    Effect.match({
      onSuccess: () => {
        store.close();
        target.apply({ type: "notice", text: `Logged in to ${way.provider.id}.` });
      },
      onFailure: (error: ConnectFailure) => {
        store.setProgress({ type: "failed", reason: error.message });
      },
    }),
  );

  store.trackLogin(target.start(login));
};

const signOut = (store: Store, target: ConnectTarget, way: ConnectWay) => {
  const logout = target.connections.logOut(way, promptFor(store, way.methods[0]?.method)).pipe(
    Effect.match({
      onSuccess: () => {
        refresh(store, target);
        target.apply({ type: "notice", text: `Logged out of ${way.provider.id}.` });
        store.back();
      },
      onFailure: (error: ConnectFailure) => {
        store.goTo(providersScreen());
        store.say(error.message);
      },
    }),
  );

  target.start(logout);
};

/** Starts a login, or asks how first when it can be finished in more than one way. */
const startWay = (store: Store, target: ConnectTarget, vendor: ConnectVendor, way: ConnectWay) => {
  if (way.methods.length > 1) store.goTo({ type: "methods", vendorId: vendor.id, way, row: 0 });
  else signIn(store, target, { vendor, way, method: way.methods[0]?.method });
};

const chooseVendor = (store: Store, target: ConnectTarget, vendor: ConnectVendor) => {
  const [only] = vendor.ways;

  if (vendor.ways.length === 1 && only !== undefined && vendor.state.kind !== "saved")
    startWay(store, target, vendor, only);
  else store.goTo({ type: "ways", vendorId: vendor.id, row: 0 });
};

/** Enter: opens a vendor, starts a login, signs out, or tries a failed login again. */
const choose = (store: Store, target: ConnectTarget) => {
  const current = store.state();
  if (current === undefined) return;
  const { screen } = current;

  if (screen.type === "providers") {
    const vendor = current.vendors[screen.row];
    if (vendor !== undefined) chooseVendor(store, target, vendor);
    return;
  }

  const vendor = vendorOf(current);
  if (vendor === undefined) return;

  if (screen.type === "ways") {
    const way = vendor.ways[screen.row];
    if (way !== undefined) startWay(store, target, vendor, way);
  } else if (screen.type === "methods") {
    const method = screen.way.methods[screen.row]?.method;
    signIn(store, target, { vendor, way: screen.way, method });
  } else if (screen.type === "signOut") signOut(store, target, screen.way);
  else if (screen.progress.type === "failed")
    signIn(store, target, { vendor, way: screen.way, method: screen.method });
};

/** Ctrl+D: asks to sign out of the way under the cursor. */
const askSignOut = (store: Store) => {
  const current = store.state();
  if (current === undefined) return;

  const way = wayToSignOut(current);

  const vendor = current.vendors.find(
    (candidate) => way !== undefined && candidate.ways.includes(way),
  );

  if (way === undefined || vendor === undefined) return;

  if (way.state.kind === "saved") store.goTo({ type: "signOut", vendorId: vendor.id, way });
  else store.say(`Nothing saved for ${way.provider.id}.`);
};

export const connectFlow = (target: ConnectTarget) => {
  const store = createStore();

  return {
    /** The dialog's state, or undefined while no dialog shows. */
    state: store.state,
    /** Opens the dialog on the providers. */
    open: () => {
      target.start(
        target.connections.vendors.pipe(
          Effect.match({
            onFailure: (error) => {
              target.apply({ type: "notice", text: `Could not read ${error.path}.` });
            },
            onSuccess: (vendors) => {
              store.open({ vendors, screen: providersScreen(), message: undefined });
            },
          }),
        ),
      );
    },
    close: store.close,
    back: store.back,
    move: (step: number) => {
      store.change((current) => moveRow(current, step));
    },
    choose: () => {
      choose(store, target);
    },
    askSignOut: () => {
      askSignOut(store);
    },
  };
};

export type ConnectFlow = ReturnType<typeof connectFlow>;
