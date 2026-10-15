/** Shows the gallery how `Button` looks. Hover it with the mouse to see the accent color. */

import { Button } from "../ui/primitives/Button.tsx";
import type { Story } from "./story.ts";

export const buttonStory: Story = {
  id: "button",
  group: "primitives",
  title: "Button",
  states: [
    {
      name: "Resting",
      fill: "content",
      view: () => <Button label="↓ Latest" onPress={() => {}} />,
    },
  ],
};
