/**
 * The transcript: the user's prompts, with `@` tags in the accent color, the answers as Markdown,
 * one line per tool call, and notices.
 */

import type { ScrollBoxRenderable, SyntaxStyle } from "@opentui/core";
import { For } from "solid-js";
import type { ChatItem, ChatState } from "./chat-state.ts";
import { tagRanges } from "../../core/TagText.ts";
import { COLORS } from "./theme.ts";

type ToolCall = Extract<ChatItem, { kind: "tool" }>;

const TOOL_MARKS: Record<ToolCall["status"], string> = { running: "○", ok: "✓", failed: "✗" };

const TOOL_COLORS: Record<ToolCall["status"], string> = {
  running: COLORS.muted,
  ok: COLORS.success,
  failed: COLORS.error,
};

export function Chat(props: { readonly chat: ChatState; readonly syntax: SyntaxStyle }) {
  return (
    <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" ref={hideScrollBar}>
      <For each={props.chat.items}>{(item) => <ChatLine item={item} syntax={props.syntax} />}</For>
    </scrollbox>
  );
}

/**
 * The transcript scrolls with the mouse wheel and keys but draws no scroll bar. The bar shows
 * itself when the text overflows, unless it is hidden by hand; the `visible` option does not
 * stop that.
 */
const hideScrollBar = (scrollbox: ScrollBoxRenderable) => {
  scrollbox.verticalScrollBar.visible = false;
};

/** An item keeps its kind for its life, so the switch runs once; the fields it shows stay reactive. */
function ChatLine(props: { readonly item: ChatItem; readonly syntax: SyntaxStyle }) {
  const item = props.item;

  switch (item.kind) {
    case "user":
      return (
        <box border borderColor={COLORS.border} paddingLeft={1} marginTop={1}>
          <text>
            <For each={promptParts(item.text)}>
              {(part) =>
                part.isTag ? <span style={{ fg: COLORS.accent }}>{part.text}</span> : part.text
              }
            </For>
          </text>
        </box>
      );
    case "assistant":
      return (
        <box marginTop={1}>
          {/* Top-level blocks render apart, so streaming redraws only the last one, as in OpenCode. */}
          <markdown
            syntaxStyle={props.syntax}
            content={item.text}
            streaming={item.streaming}
            fg={COLORS.text}
            internalBlockMode="top-level"
            tableOptions={{ style: "grid", cellPaddingX: 1 }}
          />
        </box>
      );
    case "tool":
      return <ToolLine call={item} />;
    case "notice":
      return <text fg={COLORS.warning}>{item.text}</text>;
    case "info":
      return <text fg={COLORS.muted}>{item.text}</text>;
  }
}

function ToolLine(props: { readonly call: ToolCall }) {
  return (
    <text wrapMode="none" truncate fg={TOOL_COLORS[props.call.status]}>
      {`${TOOL_MARKS[props.call.status]} ${props.call.name} ${oneLine(props.call.summary)}`}
    </text>
  );
}

/** For text drawn on one line, cut with an ellipsis where the screen ends. */
export const oneLine = (text: string) => text.replaceAll("\n", " ");

/** The prompt cut into its tags and the text between them. */
const promptParts = (text: string) => {
  const parts: { readonly text: string; readonly isTag: boolean }[] = [];
  let from = 0;

  for (const [start, end] of tagRanges(text)) {
    parts.push(
      { text: text.slice(from, start), isTag: false },
      { text: text.slice(start, end), isTag: true },
    );

    from = end;
  }

  parts.push({ text: text.slice(from), isTag: false });
  return parts.filter((part) => part.text !== "");
};
