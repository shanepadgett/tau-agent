// fallow-ignore-file unused-file,unused-export -- wired by 06-outline-show
import type { ExploreEngine } from "./engine.ts";
import type { FileIr } from "./ir.ts";
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
 * Budgeted ignore-aware multi-file IR production.
 * Yields one FileIr per supported file; cooperative macrotask between files.
 * Generator return value is the structured outcome (limit / counters).
 */
export async function* scanIr(options: ScanOptions): AsyncGenerator<FileIr, ScanOutcome> {
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

		const ir = await options.engine.irForFile(hit.absolutePath);

		// Do not emit work that finished after cancel/budget crossed during irForFile.
		if (options.signal?.aborted) return finish("cancelled");
		if (elapsed() >= maxElapsedMs) return finish("maxElapsedMs");

		filesEmitted += 1;
		yield ir;
		await new Promise<void>((resolve) => {
			setImmediate(resolve);
		});
	}

	return finish(walk.limit);
}
