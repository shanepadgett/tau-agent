/**
 * The `/connect` dialog as data: the vendors, the screen in view, the row under the cursor and
 * how far a login has come. Pure, so the dialog only draws it and the tests step through it.
 */

import type { ConnectSignIn, ConnectVendor, ConnectWay } from "../../core/Connections.ts";

/** What a login in progress shows, or waits for the user to type. */
export type Progress =
  | { readonly type: "working"; readonly lines: readonly string[] }
  | {
      readonly type: "asking";
      readonly question: string;
      /** Whether the answer is hidden as the user types it, such as an API key. */
      readonly isSecret: boolean;
      readonly answer: (text: string) => void;
    }
  | { readonly type: "failed"; readonly reason: string };

/** How a login is finished, as the login service names it. */
export type ChosenMethod = ConnectWay["methods"][number]["method"] | undefined;

export type Screen =
  | { readonly type: "providers"; readonly row: number }
  | { readonly type: "ways"; readonly vendorId: string; readonly row: number }
  | { readonly type: "signOut"; readonly vendorId: string; readonly way: ConnectWay }
  | {
      readonly type: "methods";
      readonly vendorId: string;
      readonly way: ConnectWay;
      readonly row: number;
    }
  | {
      readonly type: "login";
      readonly vendorId: string;
      readonly way: ConnectWay;
      /** The way chosen to finish the login; none when the login has no choice. */
      readonly method: ChosenMethod;
      readonly progress: Progress;
    };

export type ConnectState = {
  readonly vendors: readonly ConnectVendor[];
  readonly screen: Screen;
  /** A line under the list, such as why a key did nothing. */
  readonly message: string | undefined;
};

export const providersScreen = (row = 0): Screen => ({ type: "providers", row });

/** A saved login or a key in the environment both sign the user in. */
export const isSignedIn = (state: ConnectSignIn) => state.kind !== "none";

const vendorNamed = (state: ConnectState, id: string) =>
  state.vendors.find((vendor) => vendor.id === id);

/** The vendor whose ways the screen shows, or whose way is being signed in or out. */
export const vendorOf = (state: ConnectState): ConnectVendor | undefined => {
  const { screen } = state;
  return screen.type === "providers" ? undefined : vendorNamed(state, screen.vendorId);
};

/** The way a sign-out key acts on: the row on a vendor's screen, or the only way of a vendor. */
export const wayToSignOut = (state: ConnectState): ConnectWay | undefined => {
  const { screen } = state;
  if (screen.type === "ways") return vendorOf(state)?.ways[screen.row];
  if (screen.type !== "providers") return undefined;

  const ways = state.vendors[screen.row]?.ways;
  return ways?.length === 1 ? ways[0] : undefined;
};

const rowCount = (state: ConnectState) => {
  const { screen } = state;
  if (screen.type === "providers") return state.vendors.length;
  if (screen.type === "methods") return screen.way.methods.length;
  return screen.type === "ways" ? (vendorOf(state)?.ways.length ?? 0) : 0;
};

/** Moves the cursor `step` rows, stopping at the first and last. */
export const moveRow = (state: ConnectState, step: number): ConnectState => {
  const { screen } = state;

  if (screen.type !== "providers" && screen.type !== "ways" && screen.type !== "methods")
    return state;

  const row = Math.min(Math.max(screen.row + step, 0), rowCount(state) - 1);
  return { ...state, screen: { ...screen, row }, message: undefined };
};

/** The screen of the vendor's logins, or the providers when the vendor has one login. */
const loginsScreen = (state: ConnectState, vendorId: string): Screen => {
  const index = state.vendors.findIndex((vendor) => vendor.id === vendorId);
  const hasWays = (state.vendors[index]?.ways.length ?? 0) > 1;

  return hasWays ? { type: "ways", vendorId, row: 0 } : providersScreen(Math.max(index, 0));
};

/** The screen before `screen`; none when the dialog closes. */
export const backFrom = (state: ConnectState): Screen | undefined => {
  const { screen } = state;
  if (screen.type === "providers") return undefined;

  if (screen.type === "ways")
    return providersScreen(
      Math.max(
        state.vendors.findIndex((vendor) => vendor.id === screen.vendorId),
        0,
      ),
    );

  // A login with no choice of how has no screen of its own to go back to.
  if (screen.type === "login" && screen.way.methods.length > 1)
    return { type: "methods", vendorId: screen.vendorId, way: screen.way, row: 0 };

  return loginsScreen(state, screen.vendorId);
};
