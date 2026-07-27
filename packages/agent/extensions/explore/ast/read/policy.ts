export type ExploreReadSettings = {
	enabled: boolean;
	structureThresholdLines: number;
};

export type ReadCallKind = "full" | "ranged";

const LARGE_READ_OUTLINE_INSTRUCTION = "large file: use ranged read or show for bodies";

export function readCallKind(input: { offset?: unknown; limit?: unknown }): ReadCallKind {
	const hasOffset = typeof input.offset === "number" && Number.isFinite(input.offset);
	const hasLimit = typeof input.limit === "number" && Number.isFinite(input.limit);
	return hasOffset || hasLimit ? "ranged" : "full";
}

export function shouldOutlineFullRead(lineCount: number, structureThresholdLines: number): boolean {
	return lineCount > structureThresholdLines;
}

export function formatLargeReadOutline(outlineText: string): string {
	if (outlineText.length === 0) return LARGE_READ_OUTLINE_INSTRUCTION;
	return `${outlineText}\n${LARGE_READ_OUTLINE_INSTRUCTION}`;
}
