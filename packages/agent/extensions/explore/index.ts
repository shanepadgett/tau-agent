import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { onTauEvent } from "../../shared/events.ts";
import { createTemporaryOutputStore } from "../../shared/temporary-output-store.ts";
import { createToolRowStateStore } from "../../shared/tool-row-state.ts";
import { createExploreEngine, type ExploreEngine } from "./ast/engine.ts";
import { createDiscoverTool } from "./ast/tools/discover.ts";
import { createOutlineTool } from "./ast/tools/outline.ts";
import { createShowTool } from "./ast/tools/show.ts";

export default function exploreExtension(pi: ExtensionAPI): void {
	const rowState = createToolRowStateStore(pi, "explore.tool-row-state");
	const temporaryOutput = createTemporaryOutputStore();
	let engine: ExploreEngine | undefined;

	const engineFor = (cwd: string): ExploreEngine => {
		const absoluteCwd = resolve(cwd);
		if (engine !== undefined && engine.cwd === absoluteCwd) return engine;
		engine?.shutdown();
		engine = createExploreEngine({ cwd: absoluteCwd });
		return engine;
	};

	pi.registerTool(createOutlineTool(rowState, temporaryOutput, engineFor));
	pi.registerTool(createShowTool(rowState, engineFor));
	pi.registerTool(createDiscoverTool(rowState, temporaryOutput, engineFor));

	pi.on("session_start", async (_event, ctx) => {
		await temporaryOutput.shutdown();
		await temporaryOutput.start();
		rowState.clear();
		engine?.shutdown();
		engine = createExploreEngine({ cwd: ctx.cwd });
	});

	onTauEvent(pi, "explore.ast", "tau:file-mutation.applied", (event) => {
		if (engine === undefined) return;
		const paths = event.changes.flatMap((change) => {
			const main = resolve(event.cwd, change.path);
			if (change.move === undefined) return [main];
			return [main, resolve(event.cwd, change.move.from), resolve(event.cwd, change.move.to)];
		});
		engine.invalidate(paths);
	});

	pi.on("session_tree", () => {
		engine?.clear();
	});

	pi.on("session_shutdown", async () => {
		engine?.shutdown();
		engine = undefined;
		await temporaryOutput.shutdown();
	});
}
