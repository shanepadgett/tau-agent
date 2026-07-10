import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createToolRowStateStore } from "../../shared/tool-row-state.js";
import { createCodeSearchTool } from "./codesearch.ts";
import { createWebFetchTool } from "./webfetch.ts";
import { createWebSearchTool } from "./websearch.ts";

export default function webExtension(pi: ExtensionAPI): void {
	const rowState = createToolRowStateStore(pi, "web.tool-row-state");
	pi.registerTool(createWebFetchTool(rowState));
	pi.registerTool(createWebSearchTool(rowState));
	pi.registerTool(createCodeSearchTool(rowState));
	pi.on("session_start", () => rowState.clear());
}
