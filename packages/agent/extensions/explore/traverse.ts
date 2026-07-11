import type { Stats } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join, matchesGlob, resolve, sep } from "node:path";
import { formatPathForDisplay, isWithinPath, relativeSlash, toSlashPath } from "./path-display.ts";

export type PathKind = "file" | "dir";

export interface TraversalEntry {
	absolutePath: string;
	displayPath: string;
	type: PathKind;
	stats: Stats;
	depth: number;
	empty?: boolean;
}

export interface CollectPathOptions {
	cwd: string;
	root: string;
	maxDepth?: number;
	includeRoot: boolean;
	includeHidden: boolean;
	includeIgnored: boolean;
	includeNoise: boolean;
}

interface IgnoreRule {
	baseDir: string;
	pattern: string;
	negated: boolean;
	dirOnly: boolean;
	hasSlash: boolean;
	anchored: boolean;
}

const NOISE_PATH_NAMES = new Set([
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

function entryKind(stats: Stats): PathKind {
	return stats.isDirectory() ? "dir" : "file";
}

function pathSegments(displayPath: string): string[] {
	return displayPath.split("/").filter((segment) => segment.length > 0 && segment !== ".");
}

function hasHiddenPathSegment(displayPath: string): boolean {
	return pathSegments(displayPath).some((segment) => segment.startsWith("."));
}

function hasNoisePathSegment(displayPath: string): boolean {
	return pathSegments(displayPath).some((segment) => NOISE_PATH_NAMES.has(segment));
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
	return { baseDir, pattern: line, negated, dirOnly, hasSlash: line.includes("/"), anchored };
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

async function appendIgnoreRulesForDirectory(
	directory: string,
	inherited: readonly IgnoreRule[],
): Promise<IgnoreRule[]> {
	const rules = await readIgnoreRules(directory);
	return rules.length === 0 ? [...inherited] : [...inherited, ...rules];
}

async function collectIgnoreRulesToDirectory(cwd: string, directory: string): Promise<IgnoreRule[]> {
	const resolvedCwd = resolve(cwd);
	const resolvedDirectory = resolve(directory);
	if (!isWithinPath(resolvedCwd, resolvedDirectory)) return [];

	let current = resolvedCwd;
	let rules: IgnoreRule[] = await appendIgnoreRulesForDirectory(current, []);
	const rel = relativeSlash(resolvedCwd, resolvedDirectory);
	if (rel === ".") return rules;

	for (const segment of rel.split("/")) {
		current = join(current, segment.split("/").join(sep));
		rules = await appendIgnoreRulesForDirectory(current, rules);
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

function shouldSkipPath(
	absolutePath: string,
	kind: PathKind,
	rules: readonly IgnoreRule[],
	options: CollectPathOptions,
): boolean {
	const displayPath = formatPathForDisplay(absolutePath, options.cwd);
	if (!options.includeHidden && hasHiddenPathSegment(displayPath)) return true;
	if (!options.includeNoise && hasNoisePathSegment(displayPath)) return true;
	return !options.includeIgnored && isIgnored(absolutePath, kind, rules);
}

function sortEntries(entries: TraversalEntry[]): TraversalEntry[] {
	return entries.sort((a, b) => {
		if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
		return a.displayPath.localeCompare(b.displayPath);
	});
}

async function readDirectoryNames(directory: string, cwd: string): Promise<string[]> {
	try {
		return await readdir(directory);
	} catch {
		throw new Error(`Cannot read directory: ${formatPathForDisplay(directory, cwd)}`);
	}
}

export async function collectPaths(options: CollectPathOptions): Promise<TraversalEntry[]> {
	const entries: TraversalEntry[] = [];
	const entryByPath = new Map<string, TraversalEntry>();
	const rootStats = await lstat(options.root);
	const rootKind = entryKind(rootStats);
	const rootDirectory = rootKind === "dir" ? options.root : dirname(options.root);
	const rootRules = options.includeIgnored ? [] : await collectIgnoreRulesToDirectory(options.cwd, rootDirectory);

	function pushEntry(absolutePath: string, stats: Stats, depth: number): TraversalEntry {
		const entry = {
			absolutePath,
			displayPath: formatPathForDisplay(absolutePath, options.cwd),
			type: entryKind(stats),
			stats,
			depth,
		};
		entries.push(entry);
		entryByPath.set(absolutePath, entry);
		return entry;
	}

	if (options.includeRoot) pushEntry(options.root, rootStats, 0);
	if (rootKind !== "dir") return entries;

	async function walkDirectory(directory: string, depth: number, rules: readonly IgnoreRule[]): Promise<number> {
		if (options.maxDepth !== undefined && depth >= options.maxDepth) return 0;

		const names = await readDirectoryNames(directory, options.cwd);

		const children: TraversalEntry[] = [];
		for (const name of names) {
			const childPath = `${directory}/${name}`;
			const stats = await lstat(childPath);
			const kind = entryKind(stats);
			if (shouldSkipPath(childPath, kind, rules, options)) continue;
			children.push({
				absolutePath: childPath,
				displayPath: formatPathForDisplay(childPath, options.cwd),
				type: kind,
				stats,
				depth: depth + 1,
			});
		}

		for (const child of sortEntries(children)) {
			entries.push(child);
			entryByPath.set(child.absolutePath, child);
			if (child.type !== "dir") continue;
			const childRules = options.includeIgnored
				? rules
				: await appendIgnoreRulesForDirectory(child.absolutePath, rules);
			const visibleChildren = await walkDirectory(child.absolutePath, child.depth, childRules);
			if (visibleChildren === 0 && (options.maxDepth === undefined || child.depth < options.maxDepth)) {
				child.empty = true;
			}
		}

		return children.length;
	}

	const visibleChildren = await walkDirectory(options.root, 0, rootRules);
	const rootEntry = entryByPath.get(options.root);
	if (rootEntry && visibleChildren === 0 && (options.maxDepth === undefined || options.maxDepth > 0)) {
		rootEntry.empty = true;
	}
	return entries;
}
