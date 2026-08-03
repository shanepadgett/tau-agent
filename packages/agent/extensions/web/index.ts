import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createToolRowStateStore } from "../../shared/tool-row-state.js";
import { registerDeferredToolGroup } from "../../src/tool-loading/index.ts";
import { createCodeSearchTool } from "./codesearch.ts";
import { createWebFetchTool } from "./webfetch.ts";
import { createWebSearchTool } from "./websearch.ts";

export default function webExtension(pi: ExtensionAPI): void {
	const rowState = createToolRowStateStore(pi, "web.tool-row-state");
	registerDeferredToolGroup(pi, {
		id: "web",
		description: "Public web and implementation research",
		tools: [createWebFetchTool(rowState), createWebSearchTool(rowState), createCodeSearchTool(rowState)],
	});
	pi.on("session_start", () => rowState.clear());
}
