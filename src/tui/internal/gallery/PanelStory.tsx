/** Shows the gallery how `Panel` looks with and without a title and key hints. */

import { Panel } from "../ui/primitives/Panel.tsx";
import type { Story } from "./story.ts";

const SENTENCE = "Choose the files to attach. The list keeps your place while you type.";

export const panelStory: Story = {
  id: "panel",
  group: "primitives",
  title: "Panel",
  states: [
    {
      name: "Title and hint",
      view: () => (
        <Panel title="Files" hint="enter choose · esc close">
          <text>{SENTENCE}</text>
        </Panel>
      ),
    },
    {
      name: "Title only",
      view: () => (
        <Panel title="Files">
          <text>{SENTENCE}</text>
        </Panel>
      ),
    },
    {
      name: "Sized to its text",
      fill: "content",
      view: () => (
        <Panel title="Files" hint="enter choose · esc close">
          <text>{SENTENCE}</text>
        </Panel>
      ),
    },
    {
      name: "No title",
      view: () => (
        <Panel>
          <text>{SENTENCE}</text>
        </Panel>
      ),
    },
  ],
};
