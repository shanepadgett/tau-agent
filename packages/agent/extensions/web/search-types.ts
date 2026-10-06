export type SearchBackend = "openai-codex" | "anthropic" | "xai" | "exa";

export interface SearchRequest {
	query: string;
	maxSources: number;
	contextMaxCharacters: number;
	timeoutSeconds: number;
}

export interface SearchSource {
	url: string;
	title: string;
}

export type SearchFallbackReason =
	| "unavailable"
	| "unsupported"
	| "authentication"
	| "rate-limit"
	| "timeout"
	| "search-failed"
	| "provider-error";

export interface SearchResult {
	backend: SearchBackend;
	model: string | null;
	text: string;
	sources: SearchSource[];
	fallback: { from: SearchBackend; reason: SearchFallbackReason } | null;
}

export interface SearchAdapter {
	search(request: SearchRequest, signal: AbortSignal): Promise<SearchResult>;
}

export function searchObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
