import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { onTauEvent } from "../../shared/events.ts";
import { createTemporaryOutputStore } from "../../shared/temporary-output-store.ts";
import { createToolRowStateStore } from "../../shared/tool-row-state.ts";
import type { ExploreEngine } from "../../src/ast/engine.ts";
import type { ExploreFileGraph } from "../../src/ast/graph/file-graph.ts";
import {
	astEngineFor,
	astGraphFor,
	clearAstSession,
	invalidateAstPaths,
	restartAstSession,
	shutdownAstSession,
} from "../../src/ast/session.ts";
import { registerFileInjection } from "../../src/file-injection/index.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { registerReadOutlineHook } from "./read/hook.ts";
import { createAstSearchTool } from "./tools/ast-search.ts";
import { createContextTool } from "./tools/context.ts";
import { createDepsTool } from "./tools/deps.ts";
import { createDiscoverTool } from "./tools/discover.ts";
import { createImpactTool } from "./tools/impact.ts";
import { createOutlineTool } from "./tools/outline.ts";
import {
	createCalleesTool,
	createCallersTool,
	createImplementationsTool,
	createReferencesTool,
} from "./tools/relationships.ts";
import { createReverseDepsTool } from "./tools/reverse-deps.ts";
import { createShowTool } from "./tools/show.ts";
import { registerExploreGuidance } from "./guidance.ts";
import exploreSettings from "./settings.ts";

export default function exploreExtension(pi: ExtensionAPI): void {
	const rowState = createToolRowStateStore(pi, "explore.tool-row-state");
	const temporaryOutput = createTemporaryOutputStore();
	let readSettings = exploreSettings.defaults.read;
	const engineFor = (cwd: string): ExploreEngine => astEngineFor(cwd);
	const graphFor = (cwd: string): ExploreFileGraph => astGraphFor(cwd);

	pi.registerTool(createOutlineTool(rowState, temporaryOutput, engineFor));
	pi.registerTool(createShowTool(rowState, engineFor));
	pi.registerTool(createDiscoverTool(rowState, temporaryOutput, engineFor));
	pi.registerTool(createAstSearchTool(rowState, temporaryOutput, engineFor));
	pi.registerTool(createDepsTool(rowState, engineFor, graphFor));
	pi.registerTool(createReverseDepsTool(rowState, engineFor, graphFor));
	pi.registerTool(createCallersTool(rowState, engineFor, graphFor));
	pi.registerTool(createCalleesTool(rowState, engineFor, graphFor));
	pi.registerTool(createReferencesTool(rowState, engineFor, graphFor));
	pi.registerTool(createImplementationsTool(rowState, engineFor, graphFor));
	pi.registerTool(createImpactTool(rowState, temporaryOutput, engineFor, graphFor));
	pi.registerTool(createContextTool(rowState, temporaryOutput, engineFor, graphFor));
	registerReadOutlineHook(pi, engineFor);
	registerFileInjection(pi, rowState, {
		temporaryOutput,
		autoOutline: () => ({ enabled: readSettings.enabled, thresholdLines: readSettings.structureThresholdLines }),
	});
	registerExploreGuidance(pi);

	pi.on("session_start", async (_event, ctx) => {
		readSettings = (await loadTauExtensionSettings(ctx, exploreSettings)).read;
		await temporaryOutput.shutdown();
		await temporaryOutput.start();
		rowState.clear();
		restartAstSession(ctx.cwd);
	});

	onTauEvent(pi, "explore.ast", "tau:file-mutation.applied", (event) => {
		const paths = event.changes.flatMap((change) => {
			const main = resolve(event.cwd, change.path);
			if (change.move === undefined) return [main];
			return [main, resolve(event.cwd, change.move.from), resolve(event.cwd, change.move.to)];
		});
		invalidateAstPaths(
			paths,
			event.changes.some((change) => change.kind === "add" || change.kind === "delete" || change.move !== undefined),
		);
	});

	pi.on("session_tree", () => {
		clearAstSession();
	});

	pi.on("session_shutdown", async () => {
		shutdownAstSession();
		await temporaryOutput.shutdown();
	});
}
