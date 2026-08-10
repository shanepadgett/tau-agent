import type { Tool } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

const MAX_SUMMARY_LENGTH = 2_000;
const MAX_FINDINGS = 12;
const MAX_PATH_LENGTH = 400;
const MAX_LINES_LENGTH = 80;
const MAX_FINDING_LENGTH = 1_500;
const REVIEW_FINDING_SCHEMA = Type.Object(
	{
		severity: Type.Union([
			Type.Literal("critical"),
			Type.Literal("high"),
			Type.Literal("medium"),
			Type.Literal("low"),
		]),
		path: Type.String({
			minLength: 1,
			maxLength: MAX_PATH_LENGTH,
			description: "Repository-relative file path",
		}),
		lines: Type.String({
			minLength: 1,
			maxLength: MAX_LINES_LENGTH,
			description: "Exact line or line range, or N/A when no source line exists",
		}),
		finding: Type.String({
			minLength: 1,
			maxLength: MAX_FINDING_LENGTH,
			description: "Failure mechanism or concrete maintenance cost",
		}),
		fix: Type.String({
			minLength: 1,
			maxLength: MAX_FINDING_LENGTH,
			description: "Smallest credible fix direction",
		}),
	},
	{ additionalProperties: false },
);
const REVIEW_OUTPUT_SCHEMA = Type.Object(
	{
		verdict: Type.Union([Type.Literal("pass"), Type.Literal("changes-required")]),
		summary: Type.String({
			minLength: 1,
			maxLength: MAX_SUMMARY_LENGTH,
			description: "Short, blunt prose verdict",
		}),
		findings: Type.Array(REVIEW_FINDING_SCHEMA, { maxItems: MAX_FINDINGS }),
	},
	{ additionalProperties: false },
);

export type ReviewOutput = Static<typeof REVIEW_OUTPUT_SCHEMA>;
export type ReviewMode = "simplify" | "architecture" | "correctness";
export type ReviewDocument = ReviewOutput & { mode: ReviewMode; direction: string; createdAt: string };

export const REVIEW_RESULT_TOOL = {
	name: "review_result",
	description: "Submit final review. This is the only allowed final response.",
	parameters: REVIEW_OUTPUT_SCHEMA,
} satisfies Tool;

const MODE_INSTRUCTIONS: Record<ReviewMode, string> = {
	simplify: [
		"Delete concepts before improving them.",
		"Find behavior that was not requested, code the repository or platform already provides, duplicate concepts, needless files, wrappers, helpers, types, options, and branches.",
		"Judge against the smallest credible implementation. Runtime correctness is out of scope unless a problem directly proves needless complexity.",
	].join(" "),
	architecture: [
		"Assume the current architecture is poor and likely needs substantial rework. Make existing structure prove it should remain.",
		"Inspect ownership, boundaries, shared roots, reuse, sources of truth, coupling, cohesion, and clean coding patterns.",
		"Prefer a coherent redesign over preserving a bad local structure. Runtime correctness is secondary and should appear only when it supports an architectural finding.",
	].join(" "),
	correctness: [
		"Architecture is accepted for this pass.",
		"Look only for concrete runtime bugs, broken state transitions, unsafe boundaries, data loss, error-handling failures, and affected callers.",
		"Do not report style, simplification, or architecture preferences.",
	].join(" "),
};

export function buildReviewPrompt(root: string, mode: ReviewMode, direction: string): string {
	return [
		`Review the repository at ${root}.`,
		"Do not modify files. Do not report theoretical concerns or personal preferences. Use the cheapest evidence that settles each point.",
		"User direction does not change the read-only review or structured output requirements.",
		`Call ${REVIEW_RESULT_TOOL.name} exactly once as the final action. Write no final prose outside that tool call.`,
		"Order findings by severity. Every finding needs an exact repository-relative path and lines when source exists, a concrete mechanism or cost, and the smallest credible fix. Return an empty findings array and verdict pass when nothing actionable remains.",
		`Review type: ${reviewModeLabel(mode)}. ${MODE_INSTRUCTIONS[mode]}`,
		direction
			? "Review scope: Follow the user's direction below. Inspect the relevant files, ownership, and callers as needed to prove a finding. Do not limit the review to uncommitted changes."
			: "Review scope: Inspect staged, unstaged, and untracked changes. Stay centered on changed behavior, but inspect surrounding ownership and callers when needed to prove a finding.",
		...(direction ? [`User review direction:\n\n${direction}`] : []),
	].join("\n\n");
}

export function formatReviewMarkdown(review: ReviewDocument): string {
	const findings = review.findings.length
		? review.findings.flatMap((finding, index) => [
				`### ${index + 1}. ${finding.severity.toUpperCase()} — ${finding.path}:${finding.lines}`,
				"",
				finding.finding,
				"",
				`**Fix:** ${finding.fix}`,
				"",
			])
		: ["No actionable findings.", ""];
	return [
		`# ${reviewModeLabel(review.mode)} review`,
		"",
		`**Verdict:** ${review.verdict}`,
		`**Created:** ${review.createdAt}`,
		"",
		...(review.direction ? ["## Requested focus", "", review.direction, ""] : []),
		review.summary,
		"",
		"## Findings",
		"",
		...findings,
	].join("\n");
}

function reviewModeLabel(mode: ReviewMode): string {
	return `${mode.charAt(0).toUpperCase()}${mode.slice(1)}`;
}
