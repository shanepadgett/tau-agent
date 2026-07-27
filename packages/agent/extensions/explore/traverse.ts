import type { Stats } from "node:fs";
import { lstat, opendir, readFile } from "node:fs/promises";
import { isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";

/** Default recursive budgets for structural directory ops (path-conventions.md). */
export const DEFAULT_TRAVERSAL_BUDGETS = {
	maxFiles: 2000,
	maxSourceBytes: 64 * 1024 * 1024,
	maxDepth: 32,
	maxElapsedMs: 20_000,
} as const;

export type TraversalBudgets = {
	maxFiles: number;
	maxSourceBytes: number;
	maxDepth: number;
	maxElapsedMs: number;
};

export type PathKind = "file" | "dir";

export type TraversalHit = {
	absolutePath: string;
	displayPath: string;
	type: PathKind;
	stats: Stats;
	depth: number;
};

export type TraversalLimit = "maxFiles" | "maxSourceBytes" | "maxDepth" | "maxElapsedMs" | "cancelled";

export type TraversalResult = {
	entries: TraversalHit[];
	/** Set when a budget or cancellation stopped the walk before the tree was complete. */
	limit: TraversalLimit | undefined;
	filesVisited: number;
	sourceBytes: number;
	elapsedMs: number;
};

export type WalkOptions = {
	cwd: string;
	root: string;
	/** Include the root path itself when it is a file or directory. Default true. */
	includeRoot?: boolean;
	/** Descend into hidden path segments (name starts with `.`). Default false. */
	includeHidden?: boolean;
	/** Include paths matching gitignore-style rules. Default false. */
	includeIgnored?: boolean;
	/** Include common noise directories (node_modules, dist, …). Default false. */
	includeNoise?: boolean;
	/** Only yield files (skip directory entries in the result list). Default true. */
	filesOnly?: boolean;
	budgets?: Partial<TraversalBudgets>;
	signal?: AbortSignal;
	/**
	 * Called after each accepted file. Return false to stop early without a budget limit
	 * (caller owns the stop reason). Async allowed for cooperative yielding.
	 */
	onFile?: (hit: TraversalHit) => void | boolean | Promise<void | boolean>;
	/**
	 * If set, files for which this returns false are skipped without counting toward budgets.
	 * Directories are not filtered here.
	 */
	matchFile?: (hit: TraversalHit) => boolean;
};

type IgnoreRule = {
	baseDir: string;
	pattern: string;
	negated: boolean;
	dirOnly: boolean;
	hasSlash: boolean;
	anchored: boolean;
};

const NOISE_NAMES = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".cache",
	".next",
	".turbo",
	".parcel-cache",
	"out",
]);

export function stripLeadingAt(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

function toSlashPath(value: string): string {
	return value.replaceAll("\\", "/");
}

export function resolveExplorePath(cwd: string, input: string): string {
	const path = stripLeadingAt(input);
	if (path.length === 0) return resolve(cwd);
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

export function pathResolutionError(error: unknown, input: string): Error {
	if (error instanceof Error && "code" in error && error.code === "ENOENT") {
		return new Error(`Path not found: ${stripLeadingAt(input)}`);
	}
	return error instanceof Error ? error : new Error(String(error));
}

function isWithinPath(parent: string, child: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function formatPathForDisplay(absolutePath: string, cwd: string): string {
	const resolvedCwd = resolve(cwd);
	const resolvedPath = resolve(absolutePath);
	const rel = relative(resolvedCwd, resolvedPath);
	if (rel === "") return ".";
	if (!rel.startsWith("..") && !isAbsolute(rel)) return toSlashPath(rel);
	return toSlashPath(resolvedPath);
}

function relativeSlash(from: string, to: string): string {
	const rel = relative(resolve(from), resolve(to));
	return rel === "" ? "." : toSlashPath(rel);
}

function mergeBudgets(partial: Partial<TraversalBudgets> | undefined): TraversalBudgets {
	return {
		maxFiles: partial?.maxFiles ?? DEFAULT_TRAVERSAL_BUDGETS.maxFiles,
		maxSourceBytes: partial?.maxSourceBytes ?? DEFAULT_TRAVERSAL_BUDGETS.maxSourceBytes,
		maxDepth: partial?.maxDepth ?? DEFAULT_TRAVERSAL_BUDGETS.maxDepth,
		maxElapsedMs: partial?.maxElapsedMs ?? DEFAULT_TRAVERSAL_BUDGETS.maxElapsedMs,
	};
}

function pathSegments(displayPath: string): string[] {
	return displayPath.split("/").filter((segment) => segment.length > 0 && segment !== ".");
}

function hasHiddenSegment(displayPath: string): boolean {
	return pathSegments(displayPath).some((segment) => segment.startsWith("."));
}

function hasNoiseSegment(displayPath: string): boolean {
	return pathSegments(displayPath).some((segment) => NOISE_NAMES.has(segment));
}

function parseIgnoreLine(baseDir: string, rawLine: string): IgnoreRule | undefined {
	let line = rawLine.trim();
	if (!line || line.startsWith("#")) return undefined;
	const negated = line.startsWith("!");
	if (negated) line = line.slice(1);
	if (!line) return undefined;
	const dirOnly = line.endsWith("/");
	if (dirOnly) line = line.slice(0, -1);
	const anchored = line.startsWith("/");
	if (anchored) line = line.slice(1);
	line = toSlashPath(line);
	if (!line) return undefined;
	return {
		baseDir,
		pattern: line,
		negated,
		dirOnly,
		hasSlash: line.includes("/"),
		anchored,
	};
}

async function readIgnoreRules(baseDir: string): Promise<IgnoreRule[]> {
	try {
		const content = await readFile(join(baseDir, ".gitignore"), "utf8");
		return content
			.split(/\r?\n/)
			.map((line) => parseIgnoreLine(baseDir, line))
			.filter((rule): rule is IgnoreRule => rule !== undefined);
	} catch {
		return [];
	}
}

async function appendIgnoreRules(directory: string, inherited: readonly IgnoreRule[]): Promise<IgnoreRule[]> {
	const local = await readIgnoreRules(directory);
	return local.length === 0 ? [...inherited] : [...inherited, ...local];
}

async function collectIgnoreRulesToDirectory(cwd: string, directory: string): Promise<IgnoreRule[]> {
	const resolvedCwd = resolve(cwd);
	const resolvedDirectory = resolve(directory);
	// Outside the session cwd (absolute foreign roots): load that directory's own ignore only.
	if (!isWithinPath(resolvedCwd, resolvedDirectory)) {
		return appendIgnoreRules(resolvedDirectory, []);
	}

	let current = resolvedCwd;
	let rules = await appendIgnoreRules(current, []);
	const rel = relativeSlash(resolvedCwd, resolvedDirectory);
	if (rel === ".") return rules;

	for (const segment of rel.split("/")) {
		current = join(current, segment.split("/").join(sep));
		rules = await appendIgnoreRules(current, rules);
	}
	return rules;
}

function ignoreRuleMatches(rule: IgnoreRule, absolutePath: string, kind: PathKind): boolean {
	if (rule.dirOnly && kind !== "dir") return false;
	const rel = relativeSlash(rule.baseDir, absolutePath);
	if (rel === "." || rel.startsWith("..")) return false;
	if (rule.hasSlash || rule.anchored) return matchesGlob(rel, rule.pattern);
	return rel.split("/").some((segment) => matchesGlob(segment, rule.pattern));
}

function isIgnored(absolutePath: string, kind: PathKind, rules: readonly IgnoreRule[]): boolean {
	let ignored = false;
	for (const rule of rules) {
		if (ignoreRuleMatches(rule, absolutePath, kind)) ignored = !rule.negated;
	}
	return ignored;
}

function shouldSkip(
	absolutePath: string,
	kind: PathKind,
	rules: readonly IgnoreRule[],
	options: {
		walkRoot: string;
		includeHidden: boolean;
		includeIgnored: boolean;
		includeNoise: boolean;
	},
): boolean {
	// Hidden/noise are relative to the walk root — not the session cwd display path.
	// Otherwise absolute roots under ~/.local (etc.) look entirely "hidden".
	const rel = relativeSlash(options.walkRoot, absolutePath);
	const underRoot = rel === "." || (!rel.startsWith("..") && !isAbsolute(rel));
	const segmentPath = underRoot && rel !== "." ? rel : "";
	if (!options.includeHidden && segmentPath.length > 0 && hasHiddenSegment(segmentPath)) return true;
	if (!options.includeNoise && segmentPath.length > 0 && hasNoiseSegment(segmentPath)) return true;
	return !options.includeIgnored && isIgnored(absolutePath, kind, rules);
}

function entryKind(stats: Stats): PathKind {
	return stats.isDirectory() ? "dir" : "file";
}

function sortHits(hits: TraversalHit[]): TraversalHit[] {
	return hits.sort((a, b) => {
		if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
		return a.displayPath.localeCompare(b.displayPath);
	});
}

async function listNames(directory: string, cwd: string): Promise<string[]> {
	try {
		const names: string[] = [];
		for await (const entry of await opendir(directory)) {
			names.push(entry.name);
		}
		return names;
	} catch {
		throw new Error(`Cannot read directory: ${formatPathForDisplay(directory, cwd)}`);
	}
}

/**
 * Ignore-aware directory walk for structural scans.
 * Budgets (files / source bytes / depth / elapsed) are separate from model output limits.
 * Hitting a budget sets `result.limit` — not silent complete-tree success.
 */
export async function walkPaths(options: WalkOptions): Promise<TraversalResult> {
	const budgets = mergeBudgets(options.budgets);
	const includeRoot = options.includeRoot !== false;
	const includeHidden = options.includeHidden === true;
	const includeIgnored = options.includeIgnored === true;
	const includeNoise = options.includeNoise === true;
	const filesOnly = options.filesOnly !== false;
	const started = Date.now();

	const entries: TraversalHit[] = [];
	let filesVisited = 0;
	let sourceBytes = 0;
	let limit: TraversalLimit | undefined;

	const elapsed = () => Date.now() - started;

	const budgetHit = (): TraversalLimit | undefined => {
		if (options.signal?.aborted) return "cancelled";
		if (elapsed() >= budgets.maxElapsedMs) return "maxElapsedMs";
		if (filesVisited >= budgets.maxFiles) return "maxFiles";
		if (sourceBytes > budgets.maxSourceBytes) return "maxSourceBytes";
		return undefined;
	};

	const stopIfNeeded = (): boolean => {
		const hit = budgetHit();
		if (hit === undefined) return false;
		limit = limit ?? hit;
		return true;
	};

	async function pushFile(hit: TraversalHit): Promise<boolean> {
		if (options.matchFile !== undefined && !options.matchFile(hit)) return true;
		if (stopIfNeeded()) return false;
		if (filesVisited >= budgets.maxFiles) {
			limit = "maxFiles";
			return false;
		}
		const nextBytes = sourceBytes + hit.stats.size;
		// Allow the first file even if it alone exceeds the byte budget; report the limit.
		if (filesVisited > 0 && nextBytes > budgets.maxSourceBytes) {
			limit = "maxSourceBytes";
			return false;
		}
		filesVisited += 1;
		sourceBytes = nextBytes;
		if (sourceBytes > budgets.maxSourceBytes) limit = "maxSourceBytes";
		entries.push(hit);
		const cont = await options.onFile?.(hit);
		if (cont === false) return false;
		return !stopIfNeeded();
	}

	const root = resolveExplorePath(options.cwd, options.root);
	const rootStats = await lstat(root);
	const rootKind = entryKind(rootStats);
	const rootDir = rootKind === "dir" ? root : resolve(root, "..");
	const walkRoot = rootKind === "dir" ? root : rootDir;
	const skipOpts = { walkRoot, includeHidden, includeIgnored, includeNoise };
	const rootRules = includeIgnored ? [] : await collectIgnoreRulesToDirectory(options.cwd, rootDir);

	if (includeRoot) {
		const rootHit: TraversalHit = {
			absolutePath: root,
			displayPath: formatPathForDisplay(root, options.cwd),
			type: rootKind,
			stats: rootStats,
			depth: 0,
		};
		if (rootKind === "file") {
			await pushFile(rootHit);
			return { entries, limit, filesVisited, sourceBytes, elapsedMs: elapsed() };
		}
		if (!filesOnly) entries.push(rootHit);
	} else if (rootKind === "file") {
		return { entries, limit, filesVisited, sourceBytes, elapsedMs: elapsed() };
	}

	async function walkDir(directory: string, depth: number, rules: readonly IgnoreRule[]): Promise<void> {
		if (stopIfNeeded()) return;
		if (depth >= budgets.maxDepth) {
			limit = limit ?? "maxDepth";
			return;
		}

		const names = await listNames(directory, options.cwd);
		const children: TraversalHit[] = [];
		for (const name of names) {
			if (stopIfNeeded()) return;
			const childPath = join(directory, name);
			let stats: Stats;
			try {
				stats = await lstat(childPath);
			} catch {
				continue;
			}
			const kind = entryKind(stats);
			if (shouldSkip(childPath, kind, rules, skipOpts)) continue;
			children.push({
				absolutePath: childPath,
				displayPath: formatPathForDisplay(childPath, options.cwd),
				type: kind,
				stats,
				depth: depth + 1,
			});
		}

		for (const child of sortHits(children)) {
			if (stopIfNeeded()) return;
			if (child.type === "file") {
				if (!(await pushFile(child))) return;
				continue;
			}
			if (!filesOnly) entries.push(child);
			if (child.depth >= budgets.maxDepth) {
				limit = limit ?? "maxDepth";
				continue;
			}
			const childRules = includeIgnored ? rules : await appendIgnoreRules(child.absolutePath, rules);
			await walkDir(child.absolutePath, child.depth, childRules);
		}
	}

	if (rootKind === "dir") await walkDir(root, 0, rootRules);
	return { entries, limit, filesVisited, sourceBytes, elapsedMs: elapsed() };
}
