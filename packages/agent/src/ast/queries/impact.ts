import type { ExploreEngine } from "../engine.ts";
import type { Candidate } from "../identity.ts";
import type { ExploreFileGraph, FileDepHit, FileDepTarget, FileGraphEdge } from "../graph/file-graph.ts";
import {
	queryRelationships,
	type RelationshipCertainty,
	type RelationshipSite,
	type RelationshipSiteKind,
} from "../graph/relationships.ts";
import { resolveCompositeTarget, type CompositeTarget } from "./composite-target.ts";

const IMPACT_SECTION_LIMIT = 50;
/** File edges are lower value per row than symbol sites; a module import can carry hundreds. */
const IMPACT_FILE_LIMIT = 20;
export const IMPACT_DEPTH_DEFAULT = 2;
export const IMPACT_DEPTH_MAX = 5;

export type ImpactMode = "all" | "deps" | "dependents";

export type ImpactSectionId = "callees" | "fileImports" | "callers" | "fileImporters" | "transitiveDependents";

export type ImpactSiteRow = {
	kind: "site";
	path: string;
	line: number;
	siteKind: RelationshipSiteKind;
	name: string;
	preview: string;
	certainty: RelationshipCertainty;
};

export type ImpactFileRow = {
	kind: "file";
	depth: number;
	target: FileDepTarget;
};

export type ImpactRow = ImpactSiteRow | ImpactFileRow;

export type ImpactSection = {
	id: ImpactSectionId;
	label: string;
	rows: ImpactRow[];
	limit: number;
	omitted: boolean;
};

export type ImpactTarget = CompositeTarget;

export type ImpactResult =
	| {
			kind: "resolved";
			target: ImpactTarget;
			sections: ImpactSection[];
			parseDegraded: boolean;
			notes: string[];
	  }
	| { kind: "candidates"; candidates: Candidate[] }
	| { kind: "notFound" }
	| { kind: "error"; message: string };

export type ImpactQueryArgs = {
	engine: ExploreEngine;
	graph: ExploreFileGraph;
	scopePath: string;
	targetPath: string | undefined;
	name: string;
	line: number | undefined;
	depth: number;
	mode: ImpactMode;
	signal: AbortSignal;
};

function siteRows(sites: readonly RelationshipSite[]): ImpactSiteRow[] {
	return sites.slice(0, IMPACT_SECTION_LIMIT).map((site) => ({
		kind: "site" as const,
		path: site.path,
		line: site.line,
		siteKind: site.kind,
		name: site.name,
		preview: site.preview,
		certainty: site.certainty,
	}));
}

function fileRowsFromEdges(edges: readonly FileGraphEdge[]): ImpactFileRow[] {
	const rows: ImpactFileRow[] = [];
	for (const edge of edges) {
		if (rows.length >= IMPACT_FILE_LIMIT) break;
		if (edge.kind === "internal") {
			rows.push({ kind: "file", depth: 1, target: { kind: "internal", path: edge.to } });
			continue;
		}
		if (edge.kind === "package") {
			rows.push({
				kind: "file",
				depth: 1,
				target: { kind: "package", id: edge.id, dir: edge.dir, fileCount: edge.fileCount },
			});
			continue;
		}
		rows.push({ kind: "file", depth: 1, target: { kind: "external", id: edge.id } });
	}
	return rows;
}

function fileRowsFromHits(hits: readonly FileDepHit[]): ImpactFileRow[] {
	return hits.slice(0, IMPACT_FILE_LIMIT).map((hit): ImpactFileRow => {
		const { depth, ...target } = hit;
		return { kind: "file", depth, target };
	});
}

async function relationshipSection(
	args: ImpactQueryArgs,
	op: "callees" | "callers",
	id: ImpactSectionId,
	label: string,
	target: ImpactTarget,
): Promise<{ section: ImpactSection | undefined; parseDegraded: boolean; note: string | undefined }> {
	const result = await queryRelationships({
		engine: args.engine,
		graph: args.graph,
		scopePath: args.scopePath,
		op,
		targetPath: target.path,
		name: target.name,
		line: target.startLine,
		resultLimit: IMPACT_SECTION_LIMIT,
		signal: args.signal,
	});
	if (result.kind === "resolved") {
		const rows = siteRows(result.sites);
		if (rows.length === 0) return { section: undefined, parseDegraded: result.parseDegraded, note: undefined };
		return {
			section: {
				id,
				label,
				rows,
				limit: IMPACT_SECTION_LIMIT,
				omitted: result.resultLimitReached || result.sites.length > IMPACT_SECTION_LIMIT,
			},
			parseDegraded: result.parseDegraded,
			note: undefined,
		};
	}
	if (result.kind === "error") {
		return { section: undefined, parseDegraded: false, note: result.message };
	}
	return { section: undefined, parseDegraded: false, note: undefined };
}

/**
 * Blast radius composite: symbol callees/callers + file imports/importers + transitive file dependents.
 * Symbol hops are depth 1 only; `depth` applies to reverse file BFS only.
 */
export async function queryImpact(args: ImpactQueryArgs): Promise<ImpactResult> {
	const { graph, signal } = args;
	if (args.depth < 1) {
		return { kind: "error", message: "depth must be >= 1" };
	}
	const depth = Math.min(args.depth, IMPACT_DEPTH_MAX);

	const resolved = await resolveCompositeTarget(
		args.engine,
		args.scopePath,
		args.targetPath,
		args.name,
		args.line,
		"impact",
		signal,
	);
	if (resolved.kind !== "resolved") return resolved;

	const target = resolved.value.target;
	const mode = args.mode;
	const wantDeps = mode === "all" || mode === "deps";
	const wantDependents = mode === "all" || mode === "dependents";
	const sections: ImpactSection[] = [];
	const notes: string[] = [];
	let parseDegraded = resolved.value.parseDegraded;

	if (wantDeps) {
		const callees = await relationshipSection(args, "callees", "callees", "callees", target);
		if (callees.section !== undefined) sections.push(callees.section);
		if (callees.parseDegraded) parseDegraded = true;
		if (callees.note !== undefined) notes.push(callees.note);

		try {
			const edges = await graph.forwardEdges(target.path, signal);
			const rows = fileRowsFromEdges(edges);
			if (rows.length > 0) {
				sections.push({
					id: "fileImports",
					label: "file imports",
					rows,
					limit: IMPACT_FILE_LIMIT,
					omitted: edges.length > IMPACT_FILE_LIMIT,
				});
			}
		} catch (error) {
			notes.push(error instanceof Error ? error.message : String(error));
		}
	}

	if (wantDependents) {
		const callers = await relationshipSection(args, "callers", "callers", "callers", target);
		if (callers.section !== undefined) sections.push(callers.section);
		if (callers.parseDegraded) parseDegraded = true;
		if (callers.note !== undefined) notes.push(callers.note);

		try {
			const reverseLimit = IMPACT_SECTION_LIMIT * Math.max(depth, 1);
			const reverse = await graph.reverseDeps(target.path, depth, reverseLimit, signal);
			const importerHits = reverse.hits.filter((hit) => hit.depth === 1);
			const importers = fileRowsFromHits(importerHits);
			if (importers.length > 0) {
				sections.push({
					id: "fileImporters",
					label: "file importers",
					rows: importers,
					limit: IMPACT_FILE_LIMIT,
					omitted: importerHits.length > IMPACT_FILE_LIMIT,
				});
			}

			if (depth >= 2) {
				const transitiveHits = reverse.hits.filter((hit) => hit.depth >= 2 && hit.depth <= depth);
				const transitive = fileRowsFromHits(transitiveHits);
				if (transitive.length > 0) {
					sections.push({
						id: "transitiveDependents",
						label: "transitive dependents",
						rows: transitive,
						limit: IMPACT_FILE_LIMIT,
						omitted: transitiveHits.length > IMPACT_FILE_LIMIT || reverse.resultLimitReached,
					});
				}
			}
		} catch (error) {
			notes.push(error instanceof Error ? error.message : String(error));
		}
	}

	return {
		kind: "resolved",
		target,
		sections,
		parseDegraded,
		notes: [...new Set(notes)],
	};
}
