import { SyntaxStyle, RGBA } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/solid";
import { createSignal, For } from "solid-js";
import { addSidebarSlot, session, sidebarSlots } from "./sdk.ts";

type Message = { role: "user" | "assistant"; text: string; streaming: boolean };

const reply = `Here is a **markdown** reply with code:

\`\`\`ts
export function add(a: number, b: number): number {
	return a + b;
}
\`\`\`

- one
- two
`;

addSidebarSlot("tau.context", () => (
	<box flexDirection="column">
		<text>
			<b>Context</b>
		</text>
		<text fg="#888888">{session.tokens().toLocaleString()} tokens</text>
		<text fg="#888888">{((session.tokens() / session.window) * 100).toFixed(1)}% used</text>
	</box>
));

export function App() {
	const renderer = useRenderer();
	const syntax = SyntaxStyle.fromStyles(
		{
			keyword: { fg: RGBA.fromHex("#c678dd") },
			string: { fg: RGBA.fromHex("#98c379") },
			type: { fg: RGBA.fromHex("#e5c07b") },
			function: { fg: RGBA.fromHex("#61afef") },
			default: { fg: RGBA.fromHex("#dddddd") },
		},
		renderer.nativeScene,
	);
	const [messages, setMessages] = createSignal<Message[]>([]);

	useKeyboard((key) => {
		if (key.ctrl && key.name === "c") {
			renderer.destroy();
			process.exit(0);
		}
	});

	async function submit(text: string) {
		if (!text.trim()) return;
		setMessages((list) => [...list, { role: "user", text, streaming: false }, { role: "assistant", text: "", streaming: true }]);
		for (let i = 0; i < reply.length; i += 6) {
			await Bun.sleep(15);
			setMessages((list) => {
				const next = [...list];
				next[next.length - 1] = { role: "assistant", text: reply.slice(0, i + 6), streaming: i + 6 < reply.length };
				return next;
			});
			session.setTokens((n) => n + 2);
		}
	}

	const [draft, setDraft] = createSignal("");

	return (
		<box flexDirection="row" width="100%" height="100%">
			<box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
				<scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
					<For each={messages()}>
						{(message) =>
							message.role === "user" ? (
								<box border borderColor="#555555" paddingLeft={1} marginBottom={1}>
									<text>{message.text}</text>
								</box>
							) : (
								<box marginBottom={1}>
									<markdown syntaxStyle={syntax} content={message.text} streaming={message.streaming} />
								</box>
							)
						}
					</For>
				</scrollbox>
				<box border borderColor="#61afef" height={3}>
					<input
						focused
						placeholder="Type a prompt and press Enter"
						value={draft()}
						onInput={setDraft}
						onSubmit={(value: string) => {
							setDraft("");
							void submit(value);
						}}
					/>
				</box>
			</box>
			<box width={30} flexDirection="column" border borderColor="#333333" paddingLeft={1} gap={1}>
				<For each={sidebarSlots()}>{(slot) => slot.render()}</For>
			</box>
		</box>
	);
}
