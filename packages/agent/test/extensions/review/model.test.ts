import { describe, expect, it } from "vitest";
import {
	buildReviewPrompt,
	formatReviewMarkdown,
	isReviewMode,
	isReviewRecord,
	type ReviewRecord,
} from "../../../extensions/review/model.ts";
import { latestReview } from "../../../extensions/review/index.ts";

describe("review model", () => {
	it("keeps review modes distinct and requires structured output", () => {
		const simplify = buildReviewPrompt("/repo", "simplify");
		const architecture = buildReviewPrompt("/repo", "architecture");
		const correctness = buildReviewPrompt("/repo", "correctness");

		expect(simplify).toContain("Delete concepts before improving them");
		expect(architecture).toContain("substantial rework");
		expect(correctness).toContain("Look only for concrete runtime bugs");
		for (const prompt of [simplify, architecture, correctness]) {
			expect(prompt).toContain("review_result exactly once");
			expect(prompt).toContain("Do not modify files");
		}
	});

	it("formats persisted results as actionable Markdown", () => {
		const review: ReviewRecord = {
			mode: "correctness",
			root: "/repo",
			createdAt: "2026-07-28T10:00:00.000Z",
			verdict: "changes-required",
			summary: "One runtime failure remains.",
			findings: [
				{
					severity: "high",
					path: "src/run.ts",
					lines: "10-12",
					finding: "Abort loses queued work.",
					fix: "Drain queue before disposal.",
				},
			],
		};

		const markdown = formatReviewMarkdown(review);
		expect(markdown).toContain("# Correctness review");
		expect(markdown).toContain("HIGH — src/run.ts:10-12");
		expect(markdown).toContain("**Fix:** Drain queue before disposal.");
	});

	it("rejects unknown command modes", () => {
		expect(isReviewMode("architecture")).toBe(true);
		expect(isReviewMode("nuclear")).toBe(false);
	});

	it("validates persisted records with the tool contract", () => {
		const record = {
			mode: "simplify",
			root: "/repo",
			createdAt: "2026-07-28T10:00:00.000Z",
			verdict: "pass",
			summary: "Clean.",
			findings: [],
		};

		expect(isReviewRecord(record)).toBe(true);
		expect(isReviewRecord({ ...record, extra: true })).toBe(false);
		expect(isReviewRecord({ ...record, summary: "" })).toBe(false);
	});

	it("restores latest review from current session branch", () => {
		const older = {
			type: "custom" as const,
			id: "older",
			parentId: null,
			timestamp: "2026-07-28T09:00:00.000Z",
			customType: "tau.review.result",
			data: {
				mode: "simplify",
				root: "/repo",
				createdAt: "2026-07-28T09:00:00.000Z",
				verdict: "pass",
				summary: "Old",
				findings: [],
			},
		};
		const latest = {
			...older,
			data: { ...older.data, mode: "architecture", createdAt: "2026-07-28T10:00:00.000Z", summary: "Latest" },
		};

		expect(
			latestReview([
				older,
				{
					type: "custom",
					id: "other",
					parentId: "older",
					timestamp: "2026-07-28T09:30:00.000Z",
					customType: "other",
					data: {},
				},
				latest,
			])?.summary,
		).toBe("Latest");
	});
});
