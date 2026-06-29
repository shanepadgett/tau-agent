import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createToolRowStateStore } from "../../shared/tool-row-state.js";
import { registerAutoread } from "./autoread.ts";
import { createFindTool } from "./find.ts";
import { createGrepTool } from "./grep.ts";
import { createLsTool } from "./ls.ts";
import { createExploreReadTool } from "./read.ts";

export default function exploreExtension(pi: ExtensionAPI): void {
	const rowState = createToolRowStateStore(pi);
	registerAutoread(pi, rowState);
	pi.registerTool(createLsTool(rowState));
	pi.registerTool(createFindTool(rowState));
	pi.registerTool(createGrepTool(rowState));
	pi.registerTool(createExploreReadTool(rowState));
	pi.on("session_start", () => rowState.clear());
}
