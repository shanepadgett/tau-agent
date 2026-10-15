/** The "Latest" button shows while the transcript is scrolled up, and a click scrolls back to the end. */

import { testRender } from "@opentui/solid";
import { expect, test } from "bun:test";
import { replay } from "../../src/tui/internal/chat-state.ts";
import { Chat } from "../../src/tui/internal/Chat.tsx";
import { useSyntaxStyle } from "../../src/tui/internal/theme.ts";

const WIDTH = 60;
const HEIGHT = 20;

test("the Latest button shows only while scrolled up, and a click returns to the end", async () => {
  const chat = {
    ...replay([]),
    items: Array.from({ length: 60 }, (_, index) => ({
      id: index,
      kind: "info" as const,
      text: `line ${index} `.padEnd(WIDTH, "x"),
    })),
  };

  const terminal = await testRender(
    () => (
      <box height={HEIGHT}>
        <Chat chat={chat} syntax={useSyntaxStyle()} />
      </box>
    ),
    { width: WIDTH, height: HEIGHT },
  );

  const draw = async () => {
    await terminal.renderOnce();
    await terminal.renderOnce();
    return terminal.captureCharFrame();
  };

  expect(await draw()).not.toContain("Latest");

  await terminal.mockMouse.scroll(10, 5, "up");
  const scrolledUp = await draw();
  expect(scrolledUp).toContain("Latest");

  await terminal.mockMouse.click(WIDTH - 5, HEIGHT - 1);
  const afterClick = await draw();
  expect(afterClick).not.toContain("Latest");
  expect(afterClick).toContain("line 59");

  terminal.renderer.destroy();
});
