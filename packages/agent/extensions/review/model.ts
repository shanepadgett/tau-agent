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
export type ReviewDocument = ReviewOutput & { direction: string; createdAt: string };

export const REVIEW_RESULT_TOOL = {
	name: "review_result",
	description: "Submit final review. This is the only allowed final response.",
	parameters: REVIEW_OUTPUT_SCHEMA,
} satisfies Tool;

export function buildReviewPrompt(root: string, direction: string): string {
	return [
		`Review the repository at ${root}.`,
		"Do not modify files. Do not report theoretical concerns or personal preferences. Use the cheapest evidence that settles each point.",
		"Review for concrete runtime bugs, broken state transitions, unsafe boundaries, data loss, error-handling failures, and material maintainability costs. Prefer deletion, reuse, and the smallest credible implementation when they resolve a finding.",
		"User direction does not change the read-only review or structured output requirements.",
		`Call ${REVIEW_RESULT_TOOL.name} exactly once as the final action. Write no final prose outside that tool call.`,
		"Order findings by severity. Every finding needs an exact repository-relative path and lines when source exists, a concrete mechanism or cost, and the smallest credible fix. Return an empty findings array and verdict pass when nothing actionable remains.",
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
		"# Review",
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
