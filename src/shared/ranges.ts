export interface LineRange {
	startLine: number;
	endLine: number;
}

export function mergeLineRanges<Range extends LineRange>(ranges: Range[]): Range[] {
	const sorted = ranges
		.filter((range) => Number.isInteger(range.startLine) && Number.isInteger(range.endLine) && range.startLine > 0)
		.map((range) => ({ ...range, endLine: Math.max(range.startLine, range.endLine) }))
		.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
	const merged: Range[] = [];
	for (const range of sorted) {
		const previous = merged[merged.length - 1];
		if (previous && range.startLine <= previous.endLine + 3) {
			previous.endLine = Math.max(previous.endLine, range.endLine);
		} else {
			merged.push({ ...range });
		}
	}
	return merged;
}
