import { createExploreEngine, type ExploreEngine } from "../../../src/ast/engine.ts";
import { createFileGraph, type ExploreFileGraph } from "../../../src/ast/graph/file-graph.ts";
import { createWorkspace, type Workspace } from "../../helpers.ts";

export type ExploreFixture = {
	workspace: Workspace;
	engine: ExploreEngine;
	graph: ExploreFileGraph;
	signal: AbortSignal;
};

/** Workspace + engine + file graph, torn down after the body runs. */
export async function withExplore(
	files: Record<string, string>,
	body: (fixture: ExploreFixture) => Promise<void>,
): Promise<void> {
	const workspace = await createWorkspace();
	const engine = createExploreEngine({ cwd: workspace.dir });
	try {
		for (const [path, content] of Object.entries(files)) {
			await workspace.write(path, content);
		}
		await body({ workspace, engine, graph: createFileGraph(engine), signal: new AbortController().signal });
	} finally {
		engine.shutdown();
		await workspace.cleanup();
	}
}
