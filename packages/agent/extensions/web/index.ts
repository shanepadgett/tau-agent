import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTemporaryOutputStore } from "../../shared/temporary-output-store.ts";
import { createToolRowStateStore } from "../../shared/tool-row-state.js";
import { registerToolGroup } from "../../src/tool-loading/index.ts";
import { registerWebGuidance } from "./guidance.ts";
import { createWebFetchTool } from "./webfetch.ts";
import { createWebSearchTool } from "./websearch.ts";

export default function webExtension(pi: ExtensionAPI): void {
	const rowState = createToolRowStateStore(pi, "web.tool-row-state");
	const temporaryOutput = createTemporaryOutputStore();
	registerToolGroup(pi, {
		id: "web",
		exposure: "codemode",
		description: "Public web research",
		tools: [createWebFetchTool(rowState, temporaryOutput), createWebSearchTool(rowState, temporaryOutput)],
	});
	registerWebGuidance(pi);
	pi.on("session_start", async () => {
		rowState.clear();
		await temporaryOutput.shutdown();
		await temporaryOutput.start();
	});
	pi.on("session_shutdown", async () => {
		await temporaryOutput.shutdown();
	});
}
