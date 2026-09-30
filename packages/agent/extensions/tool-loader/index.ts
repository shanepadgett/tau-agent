import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TOOL_SEARCH = "tool_search";

export default function toolLoaderExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const tools = pi.getAllTools();
		if (!tools.some((tool) => tool.exposure === "deferred")) return;
		if (!tools.some((tool) => tool.name === TOOL_SEARCH)) {
			ctx.ui.notify("Deferred tool groups need Pi's built-in tool_search extension, which is disabled.", "warning");
			return;
		}
		const active = pi.getActiveTools();
		if (!active.includes(TOOL_SEARCH)) pi.setActiveTools([...active, TOOL_SEARCH]);
	});
}
