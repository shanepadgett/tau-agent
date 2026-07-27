export type ExploreReadSettings = {
	enabled: boolean;
	structureThresholdLines: number;
	maxRangeLines: number;
};

export type ReadCallKind = "full" | "ranged";

const LARGE_READ_OUTLINE_INSTRUCTION = "large file: use ranged read or show for bodies";

/** Newline-based line count (empty string → 0). */
export function countLines(text: string): number {
	if (text.length === 0) return 0;
	let count = 1;
	for (let i = 0; i < text.length; i += 1) {
		const code = text.charCodeAt(i);
		if (code === 10) count += 1;
		else if (code === 13) {
			count += 1;
			if (text.charCodeAt(i + 1) === 10) i += 1;
		}
	}
	return count;
}

export function readCallKind(input: { offset?: unknown; limit?: unknown }): ReadCallKind {
	const hasOffset = typeof input.offset === "number" && Number.isFinite(input.offset);
	const hasLimit = typeof input.limit === "number" && Number.isFinite(input.limit);
	return hasOffset || hasLimit ? "ranged" : "full";
}

export function shouldOutlineFullRead(lineCount: number, structureThresholdLines: number): boolean {
	return lineCount > structureThresholdLines;
}

/** Hard-error message when a ranged read exceeds maxRangeLines; undefined when allowed. */
export function rangedReadOverLimitMessage(options: {
	limit: number | undefined;
	returnedLines: number;
	maxRangeLines: number;
}): string | undefined {
	const { limit, returnedLines, maxRangeLines } = options;
	if (typeof limit === "number" && limit > maxRangeLines) {
		return `Range limit ${limit} exceeds explore.read.maxRangeLines (${maxRangeLines}). Shrink limit and retry.`;
	}
	if (returnedLines > maxRangeLines) {
		return `Ranged read returned ${returnedLines} lines; max is explore.read.maxRangeLines (${maxRangeLines}). Set a smaller limit and retry.`;
	}
	return undefined;
}

export function formatLargeReadOutline(outlineText: string): string {
	if (outlineText.length === 0) return LARGE_READ_OUTLINE_INSTRUCTION;
	return `${outlineText}\n${LARGE_READ_OUTLINE_INSTRUCTION}`;
}
