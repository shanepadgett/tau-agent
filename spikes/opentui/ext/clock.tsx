// Extension loaded at runtime. Uses JSX, the host's SDK, the host's Solid, and a relative helper.
import { addSidebarSlot, session } from "@shanepadgett/tau";
import { createSignal, onCleanup } from "solid-js";
import { pad } from "./helper.ts";

addSidebarSlot("ext.clock", () => {
	const [ticks, setTicks] = createSignal(0);
	const timer = setInterval(() => setTicks((n) => n + 1), 100);
	onCleanup(() => clearInterval(timer));
	return (
		<box flexDirection="column">
			<text>
				<b>Extension</b>
			</text>
			<text fg="#98c379">ticks {pad(ticks())}</text>
			<text fg="#888888">tokens x2: {session.tokens() * 2}</text>
		</box>
	);
});
