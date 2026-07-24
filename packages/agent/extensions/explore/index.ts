import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { onTauEvent } from "../../shared/events.js";
import { createToolRowStateStore } from "../../shared/tool-row-state.js";
import { createAstTools } from "./ast-tools.ts";
import { AstWorkerClient } from "./ast-worker.ts";
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
	const astClient = new AstWorkerClient();
	const ast = createAstTools(astClient, rowState);
	registerAutoread(pi, rowState);
	pi.registerTool(ast.outline);
	pi.registerTool(ast.symbol);
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
		ast.clear();
	});
	onTauEvent(pi, "explore.ast", "tau:file-mutation.applied", (event) => {
		const paths = event.changes.flatMap((change) => [
			resolve(event.cwd, change.path),
			...(change.move ? [resolve(event.cwd, change.move.from), resolve(event.cwd, change.move.to)] : []),
		]);
		ast.invalidate(paths);
	});
	pi.on("session_compact", () => readSnapshots.clear());
	pi.on("session_tree", () => readSnapshots.clear());
	pi.on("session_shutdown", async () => {
		ast.clear();
		await astClient.shutdown();
	});
}
