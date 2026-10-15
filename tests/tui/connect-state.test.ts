/**
 * The dialog's cursor and back steps. A unit test because the cases differ only in the screen.
 */

import { expect, test } from "bun:test";
import { builtInProviders } from "../../src/ai/Providers.ts";
import type { ConnectVendor, ConnectWay } from "../../src/core/Connections.ts";
import {
  backFrom,
  type ConnectState,
  moveRow,
  providersScreen,
  wayToSignOut,
} from "../../src/tui/internal/connect-state.ts";

const [provider] = builtInProviders;

const way = (title: string): ConnectWay => {
  if (provider === undefined) throw new Error("no built-in provider");
  return { provider, title, methods: [], state: { kind: "saved" } };
};

const vendor = (id: string, ways: readonly ConnectWay[]): ConnectVendor => ({
  id,
  name: id,
  ways,
  state: { kind: "none" },
});

const state = (screen: ConnectState["screen"]): ConnectState => ({
  vendors: [vendor("one", [way("a")]), vendor("two", [way("b"), way("c")])],
  screen,
  message: undefined,
});

test("the cursor stops at the first and last row", () => {
  expect(moveRow(state(providersScreen(0)), -1).screen).toEqual(providersScreen(0));
  expect(moveRow(state(providersScreen(1)), 1).screen).toEqual(providersScreen(1));
  expect(moveRow(state(providersScreen(0)), 1).screen).toEqual(providersScreen(1));
});

test("back from the providers closes; from ways returns to the vendor's row", () => {
  expect(backFrom(state(providersScreen()))).toBeUndefined();
  expect(backFrom(state({ type: "ways", vendorId: "two", row: 1 }))).toEqual(providersScreen(1));
});

test("back from a login goes to the choice of how when it has one", () => {
  const choosing: ConnectWay = {
    ...way("d"),
    methods: [
      { method: "browser", title: "Browser" },
      { method: "headless", title: "Device code" },
    ],
  };

  const login = state({
    type: "login",
    vendorId: "two",
    way: choosing,
    method: "browser",
    progress: { type: "failed", reason: "x" },
  });

  expect(backFrom(login)).toEqual({ type: "methods", vendorId: "two", way: choosing, row: 0 });

  expect(
    moveRow(state({ type: "methods", vendorId: "two", way: choosing, row: 0 }), 5).screen,
  ).toEqual({
    type: "methods",
    vendorId: "two",
    way: choosing,
    row: 1,
  });
});

test("back from a login goes to the ways only when the vendor has several", () => {
  const login = (vendorId: string, name: string) =>
    state({
      type: "login",
      vendorId,
      way: way(name),
      method: undefined,
      progress: { type: "failed", reason: "x" },
    });

  expect(backFrom(login("two", "b"))).toEqual({ type: "ways", vendorId: "two", row: 0 });
  expect(backFrom(login("one", "a"))).toEqual(providersScreen(0));
});

test("sign-out acts on the row's way, or a vendor's only way", () => {
  expect(wayToSignOut(state(providersScreen(0)))?.title).toBe("a");
  expect(wayToSignOut(state(providersScreen(1)))).toBeUndefined();
  expect(wayToSignOut(state({ type: "ways", vendorId: "two", row: 1 }))?.title).toBe("c");
});
