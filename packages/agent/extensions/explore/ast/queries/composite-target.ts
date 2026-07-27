import { pathResolutionError, resolveExplorePath } from "../../traverse.ts";
import type { ExploreEngine } from "../engine.ts";
import type { Candidate } from "../identity.ts";
import { resolveTarget } from "../identity.ts";
import { isCallableLike, isTypeLike, type Decl, type DeclKind, type FileIr } from "../ir.ts";

export type CompositeTarget = {
	path: string;
	name: string;
	qualifiedName: string;
	kind: DeclKind;
	startLine: number;
};

export type CompositeResolved = {
	scopeDir: string;
	target: CompositeTarget;
	decl: Decl;
	ir: FileIr;
	source: string;
	parseDegraded: boolean;
};

export type CompositeResolveResult =
	| { kind: "resolved"; value: CompositeResolved }
	| { kind: "candidates"; candidates: Candidate[] }
	| { kind: "notFound" }
	| { kind: "error"; message: string };

/** Resolve one callable/type target under a directory scope for impact/context. */
export async function resolveCompositeTarget(
	engine: ExploreEngine,
	scopePath: string,
	targetPath: string | undefined,
	name: string,
	line: number | undefined,
	toolName: "impact" | "context",
	signal: AbortSignal,
): Promise<CompositeResolveResult> {
	let scopeDir: string;
	try {
		scopeDir = resolveExplorePath(engine.cwd, scopePath);
	} catch (error) {
		return { kind: "error", message: pathResolutionError(error, scopePath).message };
	}

	const resolution = await resolveTarget(engine, scopeDir, { path: targetPath, name, line }, signal);
	if (resolution.kind === "candidates") return { kind: "candidates", candidates: resolution.candidates };
	if (resolution.kind === "notFound") return { kind: "notFound" };

	const kind = resolution.decl.kind;
	if (!isCallableLike(kind) && !isTypeLike(kind)) {
		const alt = toolName === "impact" ? "deps/reverse_deps/references" : "show/references";
		return {
			kind: "error",
			message: `${toolName} supports callable and type targets, not ${kind}. Use ${alt}.`,
		};
	}

	return {
		kind: "resolved",
		value: {
			scopeDir,
			target: {
				path: resolution.path,
				name: resolution.decl.name,
				qualifiedName: resolution.decl.qualifiedName,
				kind,
				startLine: resolution.decl.startLine,
			},
			decl: resolution.decl,
			ir: resolution.ir,
			source: resolution.source,
			parseDegraded: resolution.ir.parseDegraded,
		},
	};
}
