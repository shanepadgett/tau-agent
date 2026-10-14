// A chat-shaped screen: header with build and status, transcript, input.
// Talks to the supervisor over Bun IPC: ready, idle, draft out; notice, exit-for-restart in.
import { useKeyboard, useRenderer } from "@opentui/solid";
import { createSignal, For, onMount } from "solid-js";
import { CRASH_AFTER_MS, VERSION } from "./version.ts";

type ToChild = { type: "notice"; text: string } | { type: "exit-for-restart" };

const send = (message: object) => process.send?.(message);

export function App(props: { draft: string }) {
	const renderer = useRenderer();
	const [draft, setDraft] = createSignal(props.draft);
	const [lines, setLines] = createSignal<string[]>([]);
	const [status, setStatus] = createSignal("idle");

	onMount(() => {
		process.on("message", (message: ToChild) => {
			if (message.type === "notice") setStatus(message.text);
			if (message.type === "exit-for-restart") {
				renderer.destroy();
				process.exit(0);
			}
		});
		setTimeout(() => send({ type: "ready", version: VERSION }), 0);
		// A thrown error would only open OpenTUI's console overlay; SIGKILL is a hard crash with no terminal cleanup.
		if (CRASH_AFTER_MS > 0) setTimeout(() => process.kill(process.pid, "SIGKILL"), CRASH_AFTER_MS);
	});

	useKeyboard((key) => {
		if (key.ctrl && key.name === "c") {
			renderer.destroy();
			process.exit(0);
		}
	});

	function submit(text: string) {
		setDraft("");
		send({ type: "draft", draft: "" });
		setLines((list) => [...list, `> ${text}`]);
		setStatus("running");
		send({ type: "idle", idle: false });
		setTimeout(() => {
			setLines((list) => [...list, `done: ${text}`]);
			setStatus("idle");
			send({ type: "idle", idle: true });
		}, 2000);
	}

	return (
		<box flexDirection="column" width="100%" height="100%">
			<box height={1}>
				<text>{`Tau build ${VERSION} | ${status()}`}</text>
			</box>
			<box flexDirection="column" flexGrow={1}>
				<For each={lines()}>{(line) => <text>{line}</text>}</For>
			</box>
			<box border height={3}>
				<input
					focused
					value={draft()}
					onInput={(value: string) => {
						setDraft(value);
						send({ type: "draft", draft: value });
					}}
					onSubmit={(value: string) => submit(value)}
				/>
			</box>
		</box>
	);
}
