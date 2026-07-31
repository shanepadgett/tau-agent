import type { Candidate } from "../identity.ts";
import { formatCandidateList } from "./relationships.ts";

type TargetedResult<Resolved extends { kind: "resolved" }> =
	| Resolved
	| { kind: "candidates"; candidates: Candidate[] }
	| { kind: "notFound" }
	| { kind: "error"; message: string };

/** Shared dispatch for query results that resolve one declaration target. */
export function formatTargetedResult<Resolved extends { kind: "resolved" }>(
	result: TargetedResult<Resolved>,
	cwd: string,
	formatResolved: (resolved: Resolved, cwd: string) => string,
): string {
	if (result.kind === "error") return result.message;
	if (result.kind === "notFound") return "No matching declaration.";
	if (result.kind === "candidates") return formatCandidateList(result.candidates, cwd);
	return formatResolved(result, cwd);
}
