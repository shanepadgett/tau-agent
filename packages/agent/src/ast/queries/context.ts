import type { ExploreEngine } from "../engine.ts";
import type { Candidate } from "../identity.ts";
import { resolveTarget } from "../identity.ts";
import { isCallableLike, isTypeLike, type Decl, type DeclKind, type FileIr } from "../ir.ts";
import { walkDecls } from "../query.ts";
import type { ExploreFileGraph } from "../graph/file-graph.ts";
import { queryRelationships, type RelationshipSite } from "../graph/relationships.ts";
import { resolveCompositeTarget, type CompositeTarget } from "./composite-target.ts";
import { extractShowView } from "./show.ts";

const CONTEXT_REL_LIMIT = 20;
const CONTEXT_FOLLOWUP_N = 8;
const CONTEXT_METHOD_CAP = 12;

export type ContextFlag = "truncated" | "target_omitted" | "body_unavailable";

export type ContextEntry = {
	path: string;
	name: string;
	qualifiedName: string;
	kind: DeclKind;
	startLine: number;
	text: string;
	tokens: number;
	view: "body" | "signature";
	flags: ContextFlag[];
};

export type ContextGroupId =
	| "target"
	| "callees"
	| "callers"
	| "calleesDepth2"
	| "callersDepth2"
	| "implementors"
	| "methods"
	| "dependents";

export type ContextGroup = {
	id: ContextGroupId;
	label: string;
	entries: ContextEntry[];
};

export type ContextTarget = CompositeTarget;

export type ContextResult =
	| {
			kind: "resolved";
			target: ContextTarget;
			budget: number;
			used: number;
			groups: ContextGroup[];
			truncated: boolean;
	  }
	| { kind: "candidates"; candidates: Candidate[] }
	| { kind: "notFound" }
	| { kind: "error"; message: string };

export type ContextQueryArgs = {
	engine: ExploreEngine;
	graph: ExploreFileGraph;
	scopePath: string;
	targetPath: string | undefined;
	name: string;
	line: number | undefined;
	budget: number;
	signal: AbortSignal;
};

type DeclSnap = {
	path: string;
	decl: Decl;
	ir: FileIr;
	source: string;
};

function tokenEstimate(text: string): number {
	return Math.ceil(text.length / 4);
}

function snapKey(snap: DeclSnap): string {
	return `${snap.path}\0${snap.decl.qualifiedName || snap.decl.name}\0${snap.decl.startLine}`;
}

function entryFrom(snap: DeclSnap, view: "body" | "signature", flags: ContextFlag[]): ContextEntry {
	const showView = view === "body" ? "declaration" : "signature";
	const block = extractShowView(snap.decl, snap.path, snap.ir, snap.source, showView);
	return {
		path: snap.path,
		name: snap.decl.name,
		qualifiedName: snap.decl.qualifiedName,
		kind: snap.decl.kind,
		startLine: snap.decl.startLine,
		text: block.text,
		tokens: tokenEstimate(block.text),
		view,
		flags,
	};
}

function bodyUnavailable(snap: DeclSnap): boolean {
	if (snap.decl.bodyStartOffset === undefined) {
		if (isTypeLike(snap.decl.kind)) {
			return snap.decl.endOffset <= snap.decl.signatureEndOffset;
		}
		return true;
	}
	return snap.decl.bodyEndOffset !== undefined && snap.decl.bodyEndOffset <= snap.decl.bodyStartOffset;
}

function tryPackEntry(
	snap: DeclSnap,
	budgetLeft: number,
	preferBody: boolean,
): { entry: ContextEntry | undefined; truncated: boolean } {
	if (preferBody && !bodyUnavailable(snap)) {
		const body = entryFrom(snap, "body", []);
		if (body.tokens <= budgetLeft && body.text.length > 0) {
			return { entry: body, truncated: false };
		}
	}

	const flags: ContextFlag[] = [];
	if (preferBody && bodyUnavailable(snap)) flags.push("body_unavailable");
	const signature = entryFrom(snap, "signature", flags);
	if (signature.tokens <= budgetLeft && signature.text.length > 0) {
		return { entry: signature, truncated: false };
	}
	return { entry: undefined, truncated: true };
}

function declCoveringLine(
	ir: FileIr,
	source: string,
	path: string,
	line: number,
	pred: (decl: Decl) => boolean,
): DeclSnap | undefined {
	let best: Decl | undefined;
	walkDecls(ir.decls, (decl) => {
		if (!pred(decl)) return;
		if (line < decl.startLine || line > decl.endLine) return;
		if (best === undefined) {
			best = decl;
			return;
		}
		const bestSpan = best.endLine - best.startLine;
		const span = decl.endLine - decl.startLine;
		if (span < bestSpan) best = decl;
	});
	if (best === undefined) return undefined;
	return { path, decl: best, ir, source };
}

async function snapsFromSites(
	engine: ExploreEngine,
	sites: readonly RelationshipSite[],
	signal: AbortSignal,
	pred: (decl: Decl) => boolean,
): Promise<DeclSnap[]> {
	const out: DeclSnap[] = [];
	const seen = new Set<string>();
	for (const site of sites) {
		signal.throwIfAborted();
		const file = await engine.sourceForFile(site.path);
		const snap = declCoveringLine(file.ir, file.source, site.path, site.line, pred);
		if (snap === undefined) continue;
		const key = snapKey(snap);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(snap);
	}
	return out;
}

async function snapsFromCalleeSites(
	engine: ExploreEngine,
	scopeDir: string,
	sites: readonly RelationshipSite[],
	signal: AbortSignal,
): Promise<DeclSnap[]> {
	const out: DeclSnap[] = [];
	const seen = new Set<string>();
	const seenNames = new Set<string>();
	for (const site of sites) {
		signal.throwIfAborted();
		if (site.name.length === 0 || seenNames.has(site.name)) continue;
		seenNames.add(site.name);
		const resolution = await resolveTarget(engine, scopeDir, { name: site.name }, signal);
		if (resolution.kind !== "resolved") continue;
		const item: DeclSnap = {
			path: resolution.path,
			decl: resolution.decl,
			ir: resolution.ir,
			source: resolution.source,
		};
		const key = snapKey(item);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(item);
	}
	return out;
}

async function relSites(
	args: ContextQueryArgs,
	op: "callees" | "callers" | "implementations",
	target: ContextTarget,
): Promise<RelationshipSite[]> {
	const result = await queryRelationships({
		engine: args.engine,
		graph: args.graph,
		scopePath: args.scopePath,
		op,
		targetPath: target.path,
		name: target.name,
		line: target.startLine,
		resultLimit: CONTEXT_REL_LIMIT,
		signal: args.signal,
	});
	if (result.kind !== "resolved") return [];
	return result.sites;
}

type PackState = {
	budget: number;
	used: number;
	truncated: boolean;
	seen: Set<string>;
	groups: ContextGroup[];
};

function packInto(
	state: PackState,
	id: ContextGroupId,
	label: string,
	snaps: readonly DeclSnap[],
	preferBody: boolean,
): void {
	const entries: ContextEntry[] = [];
	for (const snap of snaps) {
		const key = snapKey(snap);
		if (state.seen.has(key)) continue;
		const left = state.budget - state.used;
		if (left <= 0) {
			state.truncated = true;
			break;
		}
		const packed = tryPackEntry(snap, left, preferBody);
		if (packed.entry === undefined) {
			state.truncated = true;
			continue;
		}
		state.seen.add(key);
		state.used += packed.entry.tokens;
		entries.push(packed.entry);
	}
	if (entries.length > 0) {
		state.groups.push({ id, label, entries });
	}
}

/**
 * Type-like targets print signature plus members (the `methods` group covers the
 * bodies); callable targets print their own body.
 */
function packTarget(state: PackState, snap: DeclSnap, targetKind: DeclKind): void {
	const left = state.budget - state.used;
	const preferBody = !bodyUnavailable(snap) && !isTypeLike(targetKind);
	if (preferBody) {
		const body = entryFrom(snap, "body", []);
		if (body.tokens <= left && body.text.length > 0) {
			state.seen.add(snapKey(snap));
			state.used += body.tokens;
			state.groups.push({ id: "target", label: "target", entries: [body] });
			return;
		}
	}
	const flags: ContextFlag[] = isTypeLike(targetKind) ? [] : ["target_omitted"];
	if (bodyUnavailable(snap)) flags.push("body_unavailable");
	const signature = entryFrom(snap, "signature", flags);
	if (signature.tokens <= left && signature.text.length > 0) {
		state.seen.add(snapKey(snap));
		state.used += signature.tokens;
		state.groups.push({ id: "target", label: "target", entries: [signature] });
		return;
	}
	state.truncated = true;
}

/**
 * Budgeted symbol pack. Bodies/signatures via show view extraction.
 * Depth-2 is a capped second resolve+query pass — no relationship depth param.
 */
export async function queryContext(args: ContextQueryArgs): Promise<ContextResult> {
	const { engine, signal } = args;
	if (args.budget < 1) {
		return { kind: "error", message: "budget must be >= 1" };
	}

	const resolved = await resolveCompositeTarget(
		engine,
		args.scopePath,
		args.targetPath,
		args.name,
		args.line,
		"context",
		signal,
	);
	if (resolved.kind !== "resolved") return resolved;

	const { scopeDir, target, decl, ir, source } = resolved.value;
	const targetSnap: DeclSnap = { path: target.path, decl, ir, source };
	const kind = target.kind;
	const state: PackState = {
		budget: args.budget,
		used: 0,
		truncated: false,
		seen: new Set<string>(),
		groups: [],
	};

	packTarget(state, targetSnap, kind);

	if (isCallableLike(kind)) {
		const calleeSites = await relSites(args, "callees", target);
		const calleeSnaps = await snapsFromCalleeSites(engine, scopeDir, calleeSites, signal);
		packInto(state, "callees", "direct callees", calleeSnaps, true);

		const callerSites = await relSites(args, "callers", target);
		const callerSnaps = await snapsFromSites(engine, callerSites, signal, (d) => isCallableLike(d.kind));
		packInto(state, "callers", "direct callers", callerSnaps, false);

		let followUps = 0;
		const depth2Callees: DeclSnap[] = [];
		for (const snap of calleeSnaps) {
			if (followUps >= CONTEXT_FOLLOWUP_N || state.used >= state.budget) break;
			signal.throwIfAborted();
			followUps += 1;
			const sites = await relSites(args, "callees", {
				path: snap.path,
				name: snap.decl.name,
				qualifiedName: snap.decl.qualifiedName,
				kind: snap.decl.kind,
				startLine: snap.decl.startLine,
			});
			for (const item of await snapsFromCalleeSites(engine, scopeDir, sites, signal)) {
				if (!state.seen.has(snapKey(item))) depth2Callees.push(item);
			}
		}
		packInto(state, "calleesDepth2", "depth-2 callees", depth2Callees, false);

		const depth2Callers: DeclSnap[] = [];
		for (const snap of callerSnaps) {
			if (followUps >= CONTEXT_FOLLOWUP_N || state.used >= state.budget) break;
			signal.throwIfAborted();
			followUps += 1;
			const sites = await relSites(args, "callers", {
				path: snap.path,
				name: snap.decl.name,
				qualifiedName: snap.decl.qualifiedName,
				kind: snap.decl.kind,
				startLine: snap.decl.startLine,
			});
			for (const item of await snapsFromSites(engine, sites, signal, (d) => isCallableLike(d.kind))) {
				if (!state.seen.has(snapKey(item))) depth2Callers.push(item);
			}
		}
		packInto(state, "callersDepth2", "depth-2 callers", depth2Callers, false);
	} else {
		const implSites = await relSites(args, "implementations", target);
		const implSnaps = await snapsFromSites(engine, implSites, signal, (d) => isTypeLike(d.kind));
		packInto(state, "implementors", "implementors", implSnaps, true);

		const methods: DeclSnap[] = [];
		for (const child of decl.children) {
			if (!isCallableLike(child.kind)) continue;
			if (methods.length >= CONTEXT_METHOD_CAP) break;
			methods.push({ path: target.path, decl: child, ir, source });
		}
		packInto(state, "methods", "methods", methods, true);

		const dependents: DeclSnap[] = [];
		for (const method of methods) {
			if (state.used >= state.budget) break;
			signal.throwIfAborted();
			const sites = await relSites(args, "callers", {
				path: method.path,
				name: method.decl.name,
				qualifiedName: method.decl.qualifiedName,
				kind: method.decl.kind,
				startLine: method.decl.startLine,
			});
			// Method-name matching collects unrelated same-name callers; ambiguous
			// entries would spend budget correct ones need.
			const certain = sites.filter((site) => site.certainty !== "ambiguous");
			for (const item of await snapsFromSites(engine, certain, signal, (d) => isCallableLike(d.kind))) {
				if (!state.seen.has(snapKey(item))) dependents.push(item);
			}
		}
		packInto(state, "dependents", "dependents", dependents, false);
	}

	return {
		kind: "resolved",
		target,
		budget: state.budget,
		used: state.used,
		groups: state.groups,
		truncated: state.truncated,
	};
}
