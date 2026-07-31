import { resolve } from "node:path";
import { createExploreEngine, type ExploreEngine } from "./engine.ts";
import { createFileGraph, type ExploreFileGraph } from "./graph/file-graph.ts";

// One engine and file graph per process. Explore tools and file injection share
// the same parse caches instead of standing up competing engines per caller.
let current: { engine: ExploreEngine; graph: ExploreFileGraph } | undefined;

function sessionFor(cwd: string): { engine: ExploreEngine; graph: ExploreFileGraph } {
	const absoluteCwd = resolve(cwd);
	if (current !== undefined && current.engine.cwd === absoluteCwd) return current;
	current?.engine.shutdown();
	current?.graph.clear();
	const engine = createExploreEngine({ cwd: absoluteCwd });
	current = { engine, graph: createFileGraph(engine) };
	return current;
}

export function astEngineFor(cwd: string): ExploreEngine {
	return sessionFor(cwd).engine;
}

export function astGraphFor(cwd: string): ExploreFileGraph {
	return sessionFor(cwd).graph;
}

export function restartAstSession(cwd: string): void {
	current?.engine.shutdown();
	current?.graph.clear();
	current = undefined;
	sessionFor(cwd);
}

export function invalidateAstPaths(paths: readonly string[], topologyChanged: boolean): void {
	if (current === undefined) return;
	current.engine.invalidate([...paths]);
	if (topologyChanged) current.graph.clear();
	else current.graph.invalidate([...paths]);
}

export function clearAstSession(): void {
	current?.engine.clear();
	current?.graph.clear();
}

export function shutdownAstSession(): void {
	current?.engine.shutdown();
	current?.graph.clear();
	current = undefined;
}
