import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createExploreEngine, type ExploreEngine } from "../../../src/ast/engine.ts";
import { createFileGraph, type ExploreFileGraph } from "../../../src/ast/graph/file-graph.ts";

export type Workspace = {
	dir: string;
	path(relativePath: string): string;
	write(relativePath: string, content: string): Promise<void>;
	mkdir(relativePath: string): Promise<void>;
	cleanup(): Promise<void>;
};

export async function createWorkspace(): Promise<Workspace> {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "tau-test-")));
	return {
		dir,
		path(relativePath) {
			return join(dir, relativePath);
		},
		async write(relativePath, content) {
			const path = join(dir, relativePath);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content, "utf8");
		},
		async mkdir(relativePath) {
			await mkdir(join(dir, relativePath), { recursive: true });
		},
		async cleanup() {
			await rm(dir, { recursive: true, force: true });
		},
	};
}

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
