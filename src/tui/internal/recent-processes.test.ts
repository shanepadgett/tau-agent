/** The sidebar keeps an ended command for a while, then lets it go; running ones stay. */

import { expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import type { ChatProcesses } from "./chat-state.ts";
import { recentProcesses } from "./recent-processes.ts";

const SHOWN_MILLIS = 50;
const running = { id: "p1", command: "sleep 30", pty: false, state: { type: "running" } } as const;

const ended = {
  id: "p2",
  command: "true",
  pty: false,
  state: { type: "exited", exitCode: 0 },
} as const;

test("an ended command goes after its time, and a running one stays", (done) => {
  const [processes, setProcesses] = createSignal<ChatProcesses>([running]);

  const { shown, dispose } = createRoot((dispose) => ({
    shown: recentProcesses(processes, SHOWN_MILLIS),
    dispose,
  }));

  setProcesses([running, ended]);
  expect(shown().map(({ id }) => id)).toEqual(["p1", "p2"]);

  setTimeout(() => {
    expect(shown().map(({ id }) => id)).toEqual(["p1"]);
    dispose();
    done();
  }, SHOWN_MILLIS * 2);
});
