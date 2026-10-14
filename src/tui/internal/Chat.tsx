/** The transcript: the user's prompts, the answers as Markdown, one line per tool call, and notices. */

import { RGBA, SyntaxStyle } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { For } from "solid-js";
import type { ChatItem, ChatState } from "./chat-state.ts";

type ToolCall = Extract<ChatItem, { kind: "tool" }>;

const TOOL_MARKS: Record<ToolCall["status"], string> = { running: "○", ok: "✓", failed: "✗" };

const TOOL_COLORS: Record<ToolCall["status"], string> = {
  running: "#888888",
  ok: "#98c379",
  failed: "#e06c75",
};

export function Chat(props: { readonly chat: ChatState }) {
  const syntax = SyntaxStyle.fromStyles(
    {
      keyword: { fg: RGBA.fromHex("#c678dd") },
      string: { fg: RGBA.fromHex("#98c379") },
      function: { fg: RGBA.fromHex("#61afef") },
      default: { fg: RGBA.fromHex("#dddddd") },
    },
    useRenderer().nativeScene,
  );

  return (
    <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
      <For each={props.chat.items}>{(item) => <ChatLine item={item} syntax={syntax} />}</For>
    </scrollbox>
  );
}

/** An item keeps its kind for its life, so the switch runs once; the fields it shows stay reactive. */
function ChatLine(props: { readonly item: ChatItem; readonly syntax: SyntaxStyle }) {
  const item = props.item;

  switch (item.kind) {
    case "user":
      return (
        <box border borderColor="#555555" paddingLeft={1} marginTop={1}>
          <text>{item.text}</text>
        </box>
      );
    case "assistant":
      return (
        <box marginTop={1}>
          <markdown syntaxStyle={props.syntax} content={item.text} streaming={item.streaming} />
        </box>
      );
    case "tool":
      return <ToolLine call={item} />;
    case "notice":
      return <text fg="#e5c07b">{item.text}</text>;
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
