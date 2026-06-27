export type SearchEvidenceKind = "read" | "grep" | "find" | "ls" | "auto-read" | "path-update" | "forget";
export type SearchEvidenceRole = "current" | "navigation" | "inventory" | "mutation" | "memory-action";

export interface SearchEvidence {
	version: 1;
	kind: SearchEvidenceKind;
	role: SearchEvidenceRole;
	paths: string[];
	complete: boolean;
	toolCallId?: string;
}

export interface SearchEvidenceDetails {
	searchEvidence: SearchEvidence;
}

export function withSearchEvidence(
	details: object | undefined,
	evidence: SearchEvidence,
): object & SearchEvidenceDetails {
	return { ...(details ?? {}), searchEvidence: evidence };
}

export function searchEvidence(details: unknown): SearchEvidence | undefined {
	if (!isRecord(details) || !isRecord(details.searchEvidence)) return undefined;
	const evidence = details.searchEvidence;
	if (evidence.version !== 1) return undefined;
	if (!isKind(evidence.kind) || !isRole(evidence.role) || !Array.isArray(evidence.paths)) return undefined;
	if (typeof evidence.complete !== "boolean") return undefined;
	if (evidence.toolCallId !== undefined && typeof evidence.toolCallId !== "string") return undefined;
	const paths = evidence.paths.filter((path) => typeof path === "string");
	if (paths.length !== evidence.paths.length) return undefined;
	return {
		version: 1,
		kind: evidence.kind,
		role: evidence.role,
		paths,
		complete: evidence.complete,
		...(evidence.toolCallId ? { toolCallId: evidence.toolCallId } : {}),
	};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isKind(value: unknown): value is SearchEvidenceKind {
	return (
		value === "read" ||
		value === "grep" ||
		value === "find" ||
		value === "ls" ||
		value === "auto-read" ||
		value === "path-update" ||
		value === "forget"
	);
}

function isRole(value: unknown): value is SearchEvidenceRole {
	return (
		value === "current" ||
		value === "navigation" ||
		value === "inventory" ||
		value === "mutation" ||
		value === "memory-action"
	);
}
