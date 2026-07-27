import type { ExploreEngine, FileSource } from "./engine.ts";
import { DEFAULT_TRAVERSAL_BUDGETS, type TraversalBudgets, type TraversalLimit, walkPaths } from "../traverse.ts";

export type ScanOptions = {
	engine: ExploreEngine;
	cwd: string;
	root: string;
	budgets?: Partial<TraversalBudgets>;
	signal?: AbortSignal;
	includeHidden?: boolean;
	includeIgnored?: boolean;
	includeNoise?: boolean;
};

/** Structured stop reason — not prose. */
export type ScanOutcome = {
	limit: TraversalLimit | undefined;
	filesVisited: number;
	sourceBytes: number;
	elapsedMs: number;
	/** Files that produced IR (registered language only). */
	filesEmitted: number;
};

/**
 * Budgeted ignore-aware multi-file IR+bytes production.
 * Yields one FileSource per supported file; cooperative macrotask between files.
 * Generator return value is the structured outcome (limit / counters).
 */
export async function* scanSources(options: ScanOptions): AsyncGenerator<FileSource, ScanOutcome> {
	const started = Date.now();
	const maxElapsedMs = options.budgets?.maxElapsedMs ?? DEFAULT_TRAVERSAL_BUDGETS.maxElapsedMs;
	let filesEmitted = 0;

	const walk = await walkPaths({
		cwd: options.cwd,
		root: options.root,
		filesOnly: true,
		includeHidden: options.includeHidden,
		includeIgnored: options.includeIgnored,
		includeNoise: options.includeNoise,
		budgets: options.budgets,
		signal: options.signal,
		// Budgets count parseable files only — skip binaries/unregistered extensions.
		matchFile: (hit) => options.engine.registry.adapterForPath(hit.absolutePath) !== undefined,
	});

	const elapsed = () => Date.now() - started;

	const finish = (limit: TraversalLimit | undefined): ScanOutcome => ({
		limit: limit ?? walk.limit,
		filesVisited: walk.filesVisited,
		sourceBytes: walk.sourceBytes,
		elapsedMs: elapsed(),
		filesEmitted,
	});

	for (const hit of walk.entries) {
		if (options.signal?.aborted) return finish("cancelled");
		if (elapsed() >= maxElapsedMs) return finish("maxElapsedMs");

		const source = await options.engine.sourceForFile(hit.absolutePath);

		// Do not emit work that finished after cancel/budget crossed during sourceForFile.
		if (options.signal?.aborted) return finish("cancelled");
		if (elapsed() >= maxElapsedMs) return finish("maxElapsedMs");

		filesEmitted += 1;
		yield source;
		await new Promise<void>((resolve) => {
			setImmediate(resolve);
		});
	}

	return finish(walk.limit);
}
