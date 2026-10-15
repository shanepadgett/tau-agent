/** Shows the gallery how `Dialog` sits over a dimmed chat. Click outside the box to close it. */

import { For } from "solid-js";
import { Dialog, DialogRow } from "../ui/primitives/Dialog.tsx";
import type { Story } from "./story.ts";

const CHAT_LINES = [
  "› explain how the sidebar gets its width",
  "The sidebar is 32 columns when docked and slides in as a drawer below 100.",
  "› and the drawer?",
  "It draws a dimmed backdrop and moves the panel with translateX.",
  "› run the checks",
  "Running the checks…",
];

const PROVIDERS = [
  ["Anthropic", true],
  ["OpenAI", true],
  ["OpenCode Go", false],
  ["OpenRouter", false],
] as const;

const WAYS = [
  ["Sign in with ChatGPT", false],
  ["ChatGPT plan: Codex login", false],
  ["ChatGPT plan: Codex device code", false],
  ["API key", true],
] as const;

const SELECTED_ROW = 1;

function FakeChat() {
  return (
    <box flexDirection="column" paddingLeft={1}>
      <For each={CHAT_LINES}>{(line) => <text>{line}</text>}</For>
    </box>
  );
}

function Rows(props: { readonly rows: readonly (readonly [string, boolean])[] }) {
  return (
    <For each={props.rows}>
      {([label, isSignedIn], index) => (
        <DialogRow isSelected={index() === SELECTED_ROW}>
          <box flexDirection="row" justifyContent="space-between">
            <text>{label}</text>
            <text fg="#98c379">{isSignedIn ? "✓" : ""}</text>
          </box>
        </DialogRow>
      )}
    </For>
  );
}

export const dialogStory: Story = {
  id: "dialog",
  group: "primitives",
  title: "Dialog",
  states: [
    {
      name: "Providers",
      fill: "both",
      view: () => (
        <>
          <FakeChat />
          <Dialog title="Connect" hint="enter choose · esc close" onClose={() => {}}>
            <text>filter…</text>
            <box height={1} />
            <Rows rows={PROVIDERS} />
          </Dialog>
        </>
      ),
    },
    {
      name: "Ways to sign in",
      fill: "both",
      view: () => (
        <>
          <FakeChat />
          <Dialog
            title="OpenAI"
            hint="enter sign in · ctrl+d sign out · esc back"
            onClose={() => {}}
          >
            <Rows rows={WAYS} />
          </Dialog>
        </>
      ),
    },
    {
      name: "Short content",
      fill: "both",
      view: () => (
        <>
          <FakeChat />
          <Dialog title="Sign out" hint="enter sign out · esc keep" onClose={() => {}}>
            <text>Sign out of codex?</text>
          </Dialog>
        </>
      ),
    },
  ],
};
