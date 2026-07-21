import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createToolRowStateStore } from "../../shared/tool-row-state.js";
import { registerAutoread } from "./autoread.ts";
import { createFindTool } from "./find.ts";
import { createGrepTool } from "./grep.ts";
import { createLsTool } from "./ls.ts";
import { createReadCacheStore } from "./read-cache.ts";
import { createReadSnapshotStore } from "./read-snapshots.ts";
import { showReadStats } from "./read-stats.ts";
import { createExploreReadTool } from "./read.ts";

export default function exploreExtension(pi: ExtensionAPI): void {
	const rowState = createToolRowStateStore(pi, "explore.tool-row-state");
	const readCache = createReadCacheStore();
	const readSnapshots = createReadSnapshotStore();
	registerAutoread(pi, rowState);
	pi.registerTool(createLsTool(rowState));
	pi.registerTool(createFindTool(rowState));
	pi.registerTool(createGrepTool(rowState));
	pi.registerTool(createExploreReadTool(rowState, readCache, readSnapshots));
	pi.registerCommand("read-stats", {
		description: "Show estimated read token and cost savings for this session",
		async handler(_args, ctx) {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Read stats require TUI mode", "error");
				return;
			}
			await showReadStats(ctx);
		},
	});
	pi.on("session_start", () => {
		rowState.clear();
		readSnapshots.clear();
	});
	pi.on("session_compact", () => readSnapshots.clear());
	pi.on("session_tree", () => readSnapshots.clear());
}
