import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { formatPathForDisplay, pathResolutionError, resolveExplorePath } from "../traverse.ts";
import type { ExploreEngine } from "../engine.ts";
import type { Candidate, Resolution } from "../identity.ts";
import { resolveTarget } from "../identity.ts";
import {
	isCallableLike,
	isTypeLike,
	type CallKind,
	type CallSite,
	type Decl,
	type DeclKind,
	type FileIr,
	type ImportRef,
} from "../ir.ts";
import { walkDecls } from "../query.ts";
import { scanSources } from "../scan.ts";
import { compactSignature, signatureText } from "../slice.ts";
import type { ExploreFileGraph, FileGraphEdge } from "./file-graph.ts";

export type RelationshipOp = "callers" | "callees" | "references" | "implementations";

export type RelationshipSiteKind =
	| "call"
	| "construct"
	| "macro"
	| "super"
	| "import"
	| "reExport"
	| "implementation"
	| "override"
	| "reference";

export type RelationshipCertainty = "exact" | "inferred" | "ambiguous";

export type RelationshipSite = {
	path: string;
	line: number;
	kind: RelationshipSiteKind;
	name: string;
	target: { path: string; startLine: number } | undefined;
	preview: string;
	certainty: RelationshipCertainty;
	competitors: Candidate[];
};

export type RelationshipTarget = {
	path: string;
	name: string;
	qualifiedName: string;
	kind: DeclKind;
	startLine: number;
};

export type RelationshipQueryResult =
	| {
			kind: "resolved";
			target: RelationshipTarget;
			sites: RelationshipSite[];
			resultLimit: number;
			resultLimitReached: boolean;
			parseDegraded: boolean;
	  }
	| { kind: "candidates"; candidates: Candidate[] }
	| { kind: "notFound" }
	| { kind: "error"; message: string };

type DeclRef = {
	path: string;
	decl: Decl;
	ir: FileIr;
	source: string;
};

type FileBundle = {
	path: string;
	ir: FileIr;
	source: string;
	localByName: Map<string, DeclRef[]>;
	importByLocal: Map<string, ImportRef>;
};

type EdgeHit = {
	from: DeclRef;
	site: CallSite;
	targets: DeclRef[];
	certainty: RelationshipCertainty;
	competitors: Candidate[];
};

const MAX_COMPETITORS = 10;

function ownerName(qualifiedName: string): string {
	const dot = qualifiedName.lastIndexOf(".");
	if (dot <= 0) return "";
	return qualifiedName.slice(0, dot).split(".").pop() ?? "";
}

function sameDecl(a: DeclRef, b: DeclRef): boolean {
	return a.path === b.path && a.decl.startOffset === b.decl.startOffset && a.decl.name === b.decl.name;
}

/** Same callable name in same file — overloads bind as one symbol for edge matching. */
function sameOverloadGroup(a: DeclRef, b: DeclRef): boolean {
	return (
		a.path === b.path &&
		a.decl.name === b.decl.name &&
		ownerName(a.decl.qualifiedName) === ownerName(b.decl.qualifiedName) &&
		isCallableLike(a.decl.kind) &&
		isCallableLike(b.decl.kind)
	);
}

function allSameOverloadGroup(refs: readonly DeclRef[]): boolean {
	const first = refs[0];
	if (first === undefined) return false;
	return refs.every((ref) => sameOverloadGroup(ref, first));
}

function toCandidate(ref: DeclRef): Candidate {
	return {
		path: ref.path,
		name: ref.decl.name,
		qualifiedName: ref.decl.qualifiedName,
		kind: ref.decl.kind,
		startLine: ref.decl.startLine,
		endLine: ref.decl.endLine,
		signature: signatureText(ref.decl, ref.source),
	};
}

function linePreview(source: string, line: number): string {
	if (line < 1) return "";
	let current = 1;
	let start = 0;
	for (let i = 0; i < source.length; i += 1) {
		const code = source.charCodeAt(i);
		if (code === 10) {
			if (current === line) return source.slice(start, i).trim();
			current += 1;
			start = i + 1;
		} else if (code === 13) {
			const end = i;
			if (source.charCodeAt(i + 1) === 10) i += 1;
			if (current === line) return source.slice(start, end).trim();
			current += 1;
			start = i + 1;
		}
	}
	if (current === line) return source.slice(start).trim();
	return "";
}

function collectDeclRefs(path: string, ir: FileIr, source: string): DeclRef[] {
	const out: DeclRef[] = [];
	walkDecls(ir.decls, (decl) => {
		out.push({ path, decl, ir, source });
	});
	return out;
}

function buildBundle(path: string, ir: FileIr, source: string): FileBundle {
	const refs = collectDeclRefs(path, ir, source);
	const localByName = new Map<string, DeclRef[]>();
	for (const ref of refs) {
		const list = localByName.get(ref.decl.name);
		if (list === undefined) localByName.set(ref.decl.name, [ref]);
		else list.push(ref);
	}
	const importByLocal = new Map<string, ImportRef>();
	for (const imp of ir.imports) {
		for (const binding of imp.bindings) {
			importByLocal.set(binding.local, imp);
		}
	}
	return { path, ir, source, localByName, importByLocal };
}

/**
 * Owner for top-level call sites. Kept out of the IR decl tree so it never
 * reaches outline, discover, or declaration counts.
 */
function fileScopeRef(bundle: FileBundle): DeclRef {
	return {
		path: bundle.path,
		ir: bundle.ir,
		source: bundle.source,
		decl: {
			kind: "module",
			name: "",
			qualifiedName: "",
			startLine: 1,
			endLine: bundle.ir.lineCount,
			startOffset: 0,
			endOffset: bundle.source.length,
			signatureEndOffset: 0,
			visibility: "private",
			exported: false,
			children: [],
			calls: bundle.ir.fileCalls,
			bases: [],
		},
	};
}

function internalTargets(edges: readonly FileGraphEdge[]): Set<string> {
	const out = new Set<string>();
	for (const edge of edges) {
		if (edge.kind === "internal") out.add(edge.to);
	}
	return out;
}

type MethodSetEntry = { ref: DeclRef | undefined; methods: Set<string> };

/** Directory-scoped type key: a Go method set spans every file in the package. */
function methodSetKey(path: string, typeName: string): string {
	return `${dirname(path)}|${typeName}`;
}

function addMethodSetRef(out: Map<string, MethodSetEntry>, ref: DeclRef): void {
	const key = methodSetKey(ref.path, ref.decl.name);
	const existing = out.get(key);
	const entry = existing ?? { ref: undefined, methods: new Set<string>() };
	if (existing === undefined) out.set(key, entry);
	entry.ref = ref;
	for (const child of ref.decl.children) {
		if (isCallableLike(child.kind)) entry.methods.add(child.name);
	}
}

function addMethodSetOwner(out: Map<string, MethodSetEntry>, ref: DeclRef): void {
	// Go methods are file-level decls owned through qualifiedName.
	const owner = ownerName(ref.decl.qualifiedName);
	if (owner.length === 0) return;
	const key = methodSetKey(ref.path, owner);
	const existing = out.get(key);
	const entry = existing ?? { ref: undefined, methods: new Set<string>() };
	if (existing === undefined) out.set(key, entry);
	entry.methods.add(ref.decl.name);
}

function buildMethodSets(bundles: readonly FileBundle[]): Map<string, MethodSetEntry> {
	const out = new Map<string, MethodSetEntry>();
	for (const bundle of bundles) {
		for (const ref of collectDeclRefs(bundle.path, bundle.ir, bundle.source)) {
			if (isTypeLike(ref.decl.kind)) addMethodSetRef(out, ref);
			else if (isCallableLike(ref.decl.kind)) addMethodSetOwner(out, ref);
		}
	}
	return out;
}

/** Interface method names, with embedded interfaces expanded transitively. */
function requiredMethods(target: DeclRef, sets: Map<string, MethodSetEntry>): Set<string> {
	const required = new Set<string>();
	const seen = new Set<string>();
	const visit = (path: string, decl: Decl): void => {
		for (const child of decl.children) {
			if (isCallableLike(child.kind)) required.add(child.name);
		}
		for (const base of decl.bases) {
			const key = methodSetKey(path, base);
			if (seen.has(key)) continue;
			seen.add(key);
			const entry = sets.get(key);
			if (entry === undefined) continue;
			for (const name of entry.methods) required.add(name);
			if (entry.ref !== undefined) visit(entry.ref.path, entry.ref.decl);
		}
	};
	visit(target.path, target.decl);
	return required;
}

function pickByDeps(
	candidates: readonly DeclRef[],
	depPaths: ReadonlySet<string>,
): { targets: DeclRef[]; certainty: RelationshipCertainty; competitors: Candidate[] } {
	const inClosure = candidates.filter((ref) => depPaths.has(ref.path));
	if (inClosure.length === 1) {
		const only = inClosure[0];
		if (only !== undefined) return { targets: [only], certainty: "exact", competitors: [] };
	}
	if (inClosure.length > 1) {
		// Overloads of one name bind together; mixed names stay ambiguous.
		if (allSameOverloadGroup(inClosure)) return { targets: [...inClosure], certainty: "exact", competitors: [] };
		return {
			targets: [],
			certainty: "ambiguous",
			competitors: inClosure.slice(0, MAX_COMPETITORS).map(toCandidate),
		};
	}
	if (candidates.length === 1) {
		const only = candidates[0];
		if (only !== undefined) return { targets: [only], certainty: "inferred", competitors: [] };
	}
	if (candidates.length > 1) {
		if (allSameOverloadGroup(candidates)) return { targets: [...candidates], certainty: "inferred", competitors: [] };
		return {
			targets: [],
			certainty: "ambiguous",
			competitors: candidates.slice(0, MAX_COMPETITORS).map(toCandidate),
		};
	}
	return { targets: [], certainty: "inferred", competitors: [] };
}

type ResolvedCall = { targets: DeclRef[]; certainty: RelationshipCertainty; competitors: Candidate[] };

function exactTargets(refs: readonly DeclRef[]): ResolvedCall {
	return { targets: [...refs], certainty: "exact", competitors: [] };
}

function ambiguousTargets(refs: readonly DeclRef[]): ResolvedCall {
	return {
		targets: [],
		certainty: "ambiguous",
		competitors: refs.slice(0, MAX_COMPETITORS).map(toCandidate),
	};
}

function resolveLocalCall(local: readonly DeclRef[]): ResolvedCall | undefined {
	if (local.length === 1) {
		const only = local[0];
		if (only !== undefined) return exactTargets([only]);
	}
	if (local.length > 1) {
		if (allSameOverloadGroup(local)) return exactTargets(local);
		return ambiguousTargets(local);
	}
	return undefined;
}

function resolveCallName(
	name: string,
	receiver: string,
	kind: CallKind,
	from: DeclRef,
	caller: FileBundle,
	globalByName: Map<string, DeclRef[]>,
	callerDeps: ReadonlySet<string>,
): ResolvedCall {
	const callableCandidates = (globalByName.get(name) ?? []).filter((ref) =>
		kind === "construct" ? isTypeLike(ref.decl.kind) : isCallableLike(ref.decl.kind),
	);
	if (caller.importByLocal.has(name)) {
		return pickByDeps(callableCandidates, callerDeps);
	}

	const local = caller.localByName
		.get(name)
		?.filter((ref) => (kind === "construct" ? isTypeLike(ref.decl.kind) : isCallableLike(ref.decl.kind)));
	if (receiver.length === 0 && local !== undefined) {
		const resolved = resolveLocalCall(local);
		if (resolved !== undefined) return resolved;
	}

	const fromOwner = ownerName(from.decl.qualifiedName);
	const global =
		receiver.length === 0
			? callableCandidates.filter(
					(ref) => ref.decl.kind !== "method" || ownerName(ref.decl.qualifiedName) === fromOwner,
				)
			: callableCandidates;
	if (receiver.length > 0) {
		const receiverOwner = receiver === "self" || receiver === "this" ? fromOwner : receiver.split(/[.:]/u).at(-1);
		const owned = global.filter((ref) => ownerName(ref.decl.qualifiedName) === receiverOwner);
		if (owned.length > 0) return pickByDeps(owned, callerDeps);
		return { targets: [], certainty: "inferred", competitors: [] };
	}
	if (global.length === 1) {
		const only = global[0];
		if (only !== undefined) return exactTargets([only]);
	}
	// Same-name overloads across files still need dep evidence for Exact.
	return pickByDeps(global, callerDeps);
}

function siteKindFromCall(site: CallSite): RelationshipSiteKind {
	if (site.kind === "construct") return "construct";
	if (site.kind === "macro") return "macro";
	if (site.kind === "super") return "super";
	return "call";
}

function makeSite(
	path: string,
	line: number,
	kind: RelationshipSiteKind,
	name: string,
	certainty: RelationshipCertainty,
	competitors: Candidate[],
	preview: string,
): RelationshipSite {
	return {
		path,
		line,
		kind,
		name,
		target: undefined,
		certainty,
		competitors,
		preview,
	};
}

function sortSites(sites: RelationshipSite[]): RelationshipSite[] {
	return [...sites].sort((a, b) => {
		if (a.path !== b.path) return a.path < b.path ? -1 : 1;
		if (a.line !== b.line) return a.line - b.line;
		if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
		return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
	});
}

function dedupeSites(sites: readonly RelationshipSite[]): RelationshipSite[] {
	const seen = new Set<string>();
	const out: RelationshipSite[] = [];
	for (const site of sites) {
		const key = `${site.path}|${site.line}|${site.kind}|${site.name}|${site.certainty}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(site);
	}
	return out;
}

async function pathIsDirectory(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isDirectory();
	} catch {
		return false;
	}
}

function isWithinScope(scopeDir: string, filePath: string): boolean {
	const rel = relative(resolve(scopeDir), resolve(filePath));
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function edgeHitsTarget(edge: EdgeHit, target: DeclRef): boolean {
	if (edge.targets.some((ref) => sameDecl(ref, target) || sameOverloadGroup(ref, target))) return true;
	if (edge.site.name !== target.decl.name) return false;
	return edge.competitors.some((c) => c.path === target.path && c.name === target.decl.name);
}

function pushEdge(sites: RelationshipSite[], edge: EdgeHit): void {
	const site = makeSite(
		edge.from.path,
		edge.site.line,
		siteKindFromCall(edge.site),
		edge.site.name,
		edge.certainty,
		edge.competitors,
		linePreview(edge.from.source, edge.site.line),
	);
	const soleTarget = edge.targets.length === 1 ? edge.targets[0] : undefined;
	const receiverOwner = edge.site.receiver.split(/[.:]/u).at(-1);
	// Dependency-free same-module methods can still be pinned when syntax names
	// their owner. Other inferred single-name matches remain visible guesses.
	const target =
		soleTarget !== undefined &&
		(edge.certainty === "exact" ||
			edge.site.receiver === "self" ||
			edge.site.receiver === "this" ||
			ownerName(soleTarget.decl.qualifiedName) === receiverOwner)
			? soleTarget
			: undefined;
	if (target !== undefined) site.target = { path: target.path, startLine: target.decl.startLine };
	sites.push(site);
}

export type RelationshipQueryArgs = {
	engine: ExploreEngine;
	graph: ExploreFileGraph;
	scopePath: string;
	op: RelationshipOp;
	targetPath: string | undefined;
	name: string;
	line: number | undefined;
	resultLimit: number;
	signal: AbortSignal;
};

/**
 * One pipeline for callers / callees / references / implementations.
 * Uses adapter-filled CallSite / bases / import bindings on IR — no language ids here.
 */
export async function queryRelationships(args: RelationshipQueryArgs): Promise<RelationshipQueryResult> {
	const { engine, graph, op, name, line, resultLimit, signal } = args;
	let scopeDir: string;
	try {
		scopeDir = resolveExplorePath(engine.cwd, args.scopePath);
	} catch (error) {
		return { kind: "error", message: pathResolutionError(error, args.scopePath).message };
	}

	if (!(await pathIsDirectory(scopeDir))) {
		return {
			kind: "error",
			message: `Scope path must be a directory: ${formatPathForDisplay(scopeDir, engine.cwd)}`,
		};
	}

	const resolution: Resolution = await resolveTarget(engine, scopeDir, { path: args.targetPath, name, line }, signal);
	if (resolution.kind === "candidates") return { kind: "candidates", candidates: resolution.candidates };
	if (resolution.kind === "notFound") return { kind: "notFound" };

	const target: DeclRef = {
		path: resolution.path,
		decl: resolution.decl,
		ir: resolution.ir,
		source: resolution.source,
	};

	if (!isWithinScope(scopeDir, target.path)) {
		return {
			kind: "error",
			message: `Declaration is outside scope: ${formatPathForDisplay(target.path, engine.cwd)}`,
		};
	}

	const targetAdapter = engine.registry.adapterForPath(target.path);
	if (targetAdapter === undefined || !targetAdapter.capabilities.callEdges) {
		return {
			kind: "error",
			message: `Relationship edges unavailable for ${targetAdapter?.id ?? "this language"}`,
		};
	}

	const bundles: FileBundle[] = [];
	const globalByName = new Map<string, DeclRef[]>();
	let parseDegraded = resolution.ir.parseDegraded;

	const scan = scanSources({ engine, cwd: engine.cwd, root: scopeDir, signal });
	for await (const file of scan) {
		signal.throwIfAborted();
		const adapter = engine.registry.adapterForPath(file.ir.path);
		if (adapter === undefined || !adapter.capabilities.callEdges) continue;
		if (file.ir.parseDegraded) parseDegraded = true;
		bundles.push(buildBundle(file.ir.path, file.ir, file.source));
		for (const ref of collectDeclRefs(file.ir.path, file.ir, file.source)) {
			const list = globalByName.get(ref.decl.name);
			if (list === undefined) globalByName.set(ref.decl.name, [ref]);
			else list.push(ref);
		}
	}

	const depCache = new Map<string, Set<string>>();
	const depsOf = async (path: string): Promise<Set<string>> => {
		const cached = depCache.get(path);
		if (cached !== undefined) return cached;
		const edges = await graph.forwardEdges(path, signal);
		const set = internalTargets(edges);
		depCache.set(path, set);
		return set;
	};

	const edges: EdgeHit[] = [];
	for (const bundle of bundles) {
		signal.throwIfAborted();
		const deps = await depsOf(bundle.path);
		const owners = [...collectDeclRefs(bundle.path, bundle.ir, bundle.source), fileScopeRef(bundle)];
		for (const from of owners) {
			for (const site of from.decl.calls) {
				const resolved = resolveCallName(site.name, site.receiver, site.kind, from, bundle, globalByName, deps);
				edges.push({
					from,
					site,
					targets: resolved.targets,
					certainty: resolved.certainty,
					competitors: resolved.competitors,
				});
			}
		}
	}

	const sites: RelationshipSite[] = [];

	const heritageCertainty = (
		ref: DeclRef,
		deps: ReadonlySet<string>,
		candidates: readonly DeclRef[],
	): RelationshipCertainty => {
		// Same file and same directory are one package: no import edge exists to
		// prove, so label them alike rather than implying a confidence gap.
		if (ref.path === target.path || dirname(ref.path) === dirname(target.path) || deps.has(target.path)) {
			return "exact";
		}
		return candidates.length === 1 ? "inferred" : "ambiguous";
	};

	const isHeritageCandidate = (ref: DeclRef, baseName: string): boolean => {
		if (!ref.decl.bases.includes(baseName) || !isTypeLike(ref.decl.kind)) return false;
		// Never list the base type as its own implementor.
		return !(sameDecl(ref, target) || (ref.decl.name === baseName && ref.path === target.path));
	};

	const pushHeritageSite = async (
		ref: DeclRef,
		baseName: string,
		siteKind: RelationshipSiteKind,
		candidates: readonly DeclRef[],
	): Promise<void> => {
		const certainty = heritageCertainty(ref, await depsOf(ref.path), candidates);
		sites.push(
			makeSite(
				ref.path,
				ref.decl.startLine,
				siteKind,
				baseName,
				certainty,
				certainty === "ambiguous" ? candidates.slice(0, MAX_COMPETITORS).map(toCandidate) : [],
				// Declaration-shaped site: its own signature, not the annotation line above it.
				compactSignature(signatureText(ref.decl, ref.source)),
			),
		);
	};

	const heritageSites = async (baseName: string, siteKind: RelationshipSiteKind): Promise<void> => {
		const candidates = globalByName.get(baseName) ?? [];
		for (const bundle of bundles) {
			for (const ref of collectDeclRefs(bundle.path, bundle.ir, bundle.source)) {
				if (isHeritageCandidate(ref, baseName)) await pushHeritageSite(ref, baseName, siteKind, candidates);
			}
		}
	};

	if (op === "callers") {
		if (isCallableLike(target.decl.kind) || !isTypeLike(target.decl.kind)) {
			for (const edge of edges) {
				if (edgeHitsTarget(edge, target)) pushEdge(sites, edge);
			}
		}
		if (isTypeLike(target.decl.kind)) {
			for (const edge of edges) {
				// construct + bare TypeName() call (common when grammar has no separate construct node).
				if (edge.site.kind !== "construct" && edge.site.kind !== "call") continue;
				if (edge.site.name !== target.decl.name) continue;
				if (
					edgeHitsTarget(edge, target) ||
					(globalByName.get(target.decl.name) ?? []).some((r) => sameDecl(r, target))
				) {
					if (edge.targets.length === 0 && edge.competitors.length === 0) {
						const n = (globalByName.get(target.decl.name) ?? []).length;
						sites.push(
							makeSite(
								edge.from.path,
								edge.site.line,
								"construct",
								edge.site.name,
								n === 1 ? "inferred" : "ambiguous",
								n > 1
									? (globalByName.get(target.decl.name) ?? []).slice(0, MAX_COMPETITORS).map(toCandidate)
									: [],
								linePreview(edge.from.source, edge.site.line),
							),
						);
					} else {
						pushEdge(sites, edge);
					}
				}
			}
			await heritageSites(target.decl.name, "implementation");
		}
	} else if (op === "callees") {
		if (isCallableLike(target.decl.kind) || !isTypeLike(target.decl.kind)) {
			for (const edge of edges) {
				if (sameDecl(edge.from, target)) pushEdge(sites, edge);
			}
		}
		if (isTypeLike(target.decl.kind)) {
			const deps = await depsOf(target.path);
			for (const base of target.decl.bases) {
				const picked = pickByDeps(globalByName.get(base) ?? [], deps);
				sites.push(
					makeSite(
						target.path,
						target.decl.startLine,
						"implementation",
						base,
						picked.targets.length === 1
							? picked.certainty
							: (globalByName.get(base) ?? []).length === 1
								? "exact"
								: picked.certainty,
						picked.competitors,
						compactSignature(signatureText(target.decl, target.source)),
					),
				);
			}
		}
	} else if (op === "references") {
		for (const edge of edges) {
			if (edgeHitsTarget(edge, target)) pushEdge(sites, edge);
		}
		for (const bundle of bundles) {
			for (const imp of bundle.ir.imports) {
				for (const binding of imp.bindings) {
					const remote = binding.imported.length > 0 ? binding.imported : binding.local;
					if (binding.local !== target.decl.name && remote !== target.decl.name) continue;
					const deps = await depsOf(bundle.path);
					const certainty = deps.has(target.path) || bundle.path === target.path ? "exact" : "inferred";
					sites.push(
						makeSite(
							bundle.path,
							imp.startLine,
							"import",
							binding.local,
							certainty,
							[],
							linePreview(bundle.source, imp.startLine),
						),
					);
				}
			}
		}
		await heritageSites(target.decl.name, "implementation");
	} else {
		// implementations
		if (isTypeLike(target.decl.kind)) {
			await heritageSites(target.decl.name, "implementation");
			// Structurally typed interfaces (Go): a type implements by method set, with
			// nothing naming the interface. Syntax cannot check signatures — inferred.
			if (target.decl.kind === "interface" && targetAdapter.capabilities.structuralImplements) {
				const sets = buildMethodSets(bundles);
				const required = requiredMethods(target, sets);
				const reported = new Set(sites.map((site) => `${site.path}|${site.line}`));
				if (required.size > 0) {
					for (const entry of sets.values()) {
						const ref = entry.ref;
						if (ref === undefined || sameDecl(ref, target)) continue;
						if (!isTypeLike(ref.decl.kind)) continue;
						if (reported.has(`${ref.path}|${ref.decl.startLine}`)) continue;
						if (entry.methods.size < required.size) continue;
						let covers = true;
						for (const name of required) {
							if (!entry.methods.has(name)) {
								covers = false;
								break;
							}
						}
						if (!covers) continue;
						sites.push(
							makeSite(
								ref.path,
								ref.decl.startLine,
								"implementation",
								target.decl.name,
								"inferred",
								[],
								compactSignature(signatureText(ref.decl, ref.source)),
							),
						);
					}
				}
			}
		}
		if (isCallableLike(target.decl.kind)) {
			const owner = ownerName(target.decl.qualifiedName);
			if (owner.length > 0) {
				for (const bundle of bundles) {
					for (const typeRef of collectDeclRefs(bundle.path, bundle.ir, bundle.source)) {
						if (!isTypeLike(typeRef.decl.kind)) continue;
						if (!typeRef.decl.bases.includes(owner)) continue;
						for (const child of typeRef.decl.children) {
							if (child.name !== target.decl.name || !isCallableLike(child.kind)) continue;
							if (
								sameDecl({ path: typeRef.path, decl: child, ir: typeRef.ir, source: typeRef.source }, target)
							) {
								continue;
							}
							sites.push(
								makeSite(
									typeRef.path,
									child.startLine,
									"override",
									child.name,
									"inferred",
									[],
									compactSignature(signatureText(child, typeRef.source)),
								),
							);
						}
					}
				}
			}
		}
	}

	const sorted = sortSites(dedupeSites(sites));
	const limited = sorted.slice(0, resultLimit);

	return {
		kind: "resolved",
		target: {
			path: target.path,
			name: target.decl.name,
			qualifiedName: target.decl.qualifiedName,
			kind: target.decl.kind,
			startLine: target.decl.startLine,
		},
		sites: limited,
		resultLimit,
		resultLimitReached: sorted.length > resultLimit,
		parseDegraded,
	};
}
