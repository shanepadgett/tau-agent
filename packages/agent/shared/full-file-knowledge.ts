type ReadCacheMode = "baseline" | "recovery" | "unchanged" | "diff";
type ReadCachePresentation = "plain" | "line-numbered";

export interface ReadCacheMetaV1 {
	v: 1;
	pathKey: string;
	scopeKey: string;
	presentation: ReadCachePresentation;
	servedHash: string;
	baseHash?: string;
	mode: ReadCacheMode;
	baselineTokens: number;
	returnedTokens: number;
	totalLines: number;
	summary: string;
}

const COMPLETE_FILE_SCOPE = "full";
export const MAX_COMPLETE_FILE_SNAPSHOT_BYTES = 1024 * 1024;

export function createCompleteFileMeta(options: {
	pathKey: string;
	presentation: ReadCachePresentation;
	servedHash: string;
	mode: ReadCacheMode;
	sourceText: string;
	returnedText: string;
	totalLines: number;
	summary: string;
	baseHash?: string;
}): ReadCacheMetaV1 {
	return {
		v: 1,
		pathKey: options.pathKey,
		scopeKey: COMPLETE_FILE_SCOPE,
		presentation: options.presentation,
		servedHash: options.servedHash,
		baseHash: options.baseHash,
		mode: options.mode,
		baselineTokens: estimateTokens(options.sourceText),
		returnedTokens: estimateTokens(options.returnedText),
		totalLines: options.totalLines,
		summary: options.summary,
	};
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
