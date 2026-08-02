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

function noteFromError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function maybeFileSection(
	id: ImpactSectionId,
	label: string,
	rows: ImpactFileRow[],
	totalCount: number,
	limitReached = false,
): ImpactSection | undefined {
	if (rows.length === 0) return undefined;
	return {
		id,
		label,
		rows,
		limit: IMPACT_FILE_LIMIT,
		omitted: totalCount > IMPACT_FILE_LIMIT || limitReached,
	};
}

type SectionBatch = {
	sections: ImpactSection[];
	parseDegraded: boolean;
	notes: string[];
};

function emptyBatch(): SectionBatch {
	return { sections: [], parseDegraded: false, notes: [] };
}

function absorbRelationship(
	batch: SectionBatch,
	part: { section: ImpactSection | undefined; parseDegraded: boolean; note: string | undefined },
): void {
	if (part.section !== undefined) batch.sections.push(part.section);
	if (part.parseDegraded) batch.parseDegraded = true;
	if (part.note !== undefined) batch.notes.push(part.note);
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

async function collectDepsSections(args: ImpactQueryArgs, target: ImpactTarget): Promise<SectionBatch> {
	const batch = emptyBatch();
	absorbRelationship(batch, await relationshipSection(args, "callees", "callees", "callees", target));
	try {
		const edges = await args.graph.forwardEdges(target.path, args.signal);
		const section = maybeFileSection("fileImports", "file imports", fileRowsFromEdges(edges), edges.length);
		if (section !== undefined) batch.sections.push(section);
	} catch (error) {
		batch.notes.push(noteFromError(error));
	}
	return batch;
}

async function collectDependentsSections(
	args: ImpactQueryArgs,
	target: ImpactTarget,
	depth: number,
): Promise<SectionBatch> {
	const batch = emptyBatch();
	absorbRelationship(batch, await relationshipSection(args, "callers", "callers", "callers", target));
	try {
		const reverseLimit = IMPACT_SECTION_LIMIT * Math.max(depth, 1);
		const reverse = await args.graph.reverseDeps(target.path, depth, reverseLimit, args.signal);
		const importerHits = reverse.hits.filter((hit) => hit.depth === 1);
		const importers = maybeFileSection(
			"fileImporters",
			"file importers",
			fileRowsFromHits(importerHits),
			importerHits.length,
		);
		if (importers !== undefined) batch.sections.push(importers);

		if (depth >= 2) {
			const transitiveHits = reverse.hits.filter((hit) => hit.depth >= 2 && hit.depth <= depth);
			const transitive = maybeFileSection(
				"transitiveDependents",
				"transitive dependents",
				fileRowsFromHits(transitiveHits),
				transitiveHits.length,
				reverse.resultLimitReached,
			);
			if (transitive !== undefined) batch.sections.push(transitive);
		}
	} catch (error) {
		batch.notes.push(noteFromError(error));
	}
	return batch;
}

function mergeBatch(into: SectionBatch, part: SectionBatch): void {
	into.sections.push(...part.sections);
	if (part.parseDegraded) into.parseDegraded = true;
	into.notes.push(...part.notes);
}

/**
 * Blast radius composite: symbol callees/callers + file imports/importers + transitive file dependents.
 * Symbol hops are depth 1 only; `depth` applies to reverse file BFS only.
 */
export async function queryImpact(args: ImpactQueryArgs): Promise<ImpactResult> {
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
		args.signal,
	);
	if (resolved.kind !== "resolved") return resolved;

	const target = resolved.value.target;
	const mode = args.mode;
	const batch: SectionBatch = {
		sections: [],
		parseDegraded: resolved.value.parseDegraded,
		notes: [],
	};

	if (mode === "all" || mode === "deps") {
		mergeBatch(batch, await collectDepsSections(args, target));
	}
	if (mode === "all" || mode === "dependents") {
		mergeBatch(batch, await collectDependentsSections(args, target, depth));
	}

	return {
		kind: "resolved",
		target,
		sections: batch.sections,
		parseDegraded: batch.parseDegraded,
		notes: [...new Set(batch.notes)],
	};
}
