import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createToolRowStateStore } from "../../shared/tool-row-state.js";
import { registerToolGroup } from "../../src/tool-loading/index.ts";
import { registerWebGuidance } from "./guidance.ts";
import { createWebFetchTool } from "./webfetch.ts";
import { createWebSearchTool } from "./websearch.ts";

export default function webExtension(pi: ExtensionAPI): void {
	const rowState = createToolRowStateStore(pi, "web.tool-row-state");
	registerToolGroup(pi, {
		id: "web",
		exposure: "codemode",
		description: "Public web research",
		tools: [createWebFetchTool(rowState), createWebSearchTool(rowState)],
	});
	registerWebGuidance(pi);
	pi.on("session_start", () => rowState.clear());
}
