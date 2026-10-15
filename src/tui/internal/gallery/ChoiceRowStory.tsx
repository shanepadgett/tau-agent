/** Three ways to list the logins of one provider, for the user to choose between. */

import { For } from "solid-js";
import { ChoiceRow } from "../ui/components/ChoiceRow.tsx";
import { Dialog } from "../ui/primitives/Dialog.tsx";
import type { Story } from "./story.ts";

type Choice = {
  readonly label: string;
  readonly hint?: string;
  readonly isSignedIn: boolean;
};

const MIN_COLUMNS = 64;

function Choices(props: {
  readonly title: string;
  readonly hint: string;
  readonly choices: readonly Choice[];
}) {
  return (
    <Dialog title={props.title} hint={props.hint} minColumns={MIN_COLUMNS} onClose={() => {}}>
      <For each={props.choices}>
        {(choice, index) => (
          <ChoiceRow
            label={choice.label}
            hint={choice.hint}
            isSignedIn={choice.isSignedIn}
            isSelected={index() === 0}
          />
        )}
      </For>
    </Dialog>
  );
}

const PLAN_AND_KEY: readonly Choice[] = [
  { label: "ChatGPT plan", isSignedIn: true },
  { label: "API key", isSignedIn: false },
];

export const choiceRowStory: Story = {
  id: "choice-row",
  group: "components",
  title: "Choice row (OpenAI logins)",
  states: [
    {
      name: "A: the way as a hint on the row",
      fill: "both",
      view: () => (
        <Choices
          title="OpenAI"
          hint="enter sign in · ctrl+d sign out · esc back"
          choices={[
            { label: "ChatGPT plan", hint: "browser", isSignedIn: true },
            { label: "ChatGPT plan", hint: "device code", isSignedIn: true },
            { label: "API key", isSignedIn: false },
          ]}
        />
      ),
    },
    {
      name: "B1: the logins",
      fill: "both",
      view: () => (
        <Choices
          title="OpenAI"
          hint="enter sign in · ctrl+d sign out · esc back"
          choices={PLAN_AND_KEY}
        />
      ),
    },
    {
      name: "B2: the way, after Enter on ChatGPT plan",
      fill: "both",
      view: () => (
        <Choices
          title="ChatGPT plan"
          hint="enter sign in · esc back"
          choices={[
            { label: "Browser", isSignedIn: false },
            { label: "Device code", isSignedIn: false },
          ]}
        />
      ),
    },
    {
      name: "C: the logins, the other way on a key",
      fill: "both",
      view: () => (
        <Choices
          title="OpenAI"
          hint="enter sign in · d device code · ctrl+d sign out · esc back"
          choices={PLAN_AND_KEY}
        />
      ),
    },
  ],
};
