import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveEffortCandidates } from "../../shared/model-effort.ts";
import { createExaSearch } from "./exa.ts";
import { createHostedSearch } from "./hosted-search.ts";
import type { SearchBackend, SearchFallbackReason, SearchRequest, SearchResult } from "./search-types.ts";

export function createSearchService() {
	const exa = createExaSearch();
	return async (
		ctx: ExtensionContext,
		request: SearchRequest,
		signal: AbortSignal | undefined,
	): Promise<SearchResult> => {
		signal?.throwIfAborted();
		const deadline = AbortSignal.timeout(request.timeoutSeconds * 1000);
		const overall = signal ? AbortSignal.any([signal, deadline]) : deadline;
		const provider = ctx.model?.provider;
		const backend: Exclude<SearchBackend, "exa"> | null =
			provider === "openai-codex" || provider === "anthropic" || provider === "xai" ? provider : null;
		let fallback: SearchResult["fallback"] = null;
		if (backend) {
			// Model resolution and hosted search get 70%; Exa gets the remaining time.
			const nativeDeadline = AbortSignal.timeout(Math.floor(request.timeoutSeconds * 700));
			const nativeSignal = AbortSignal.any([overall, nativeDeadline]);
			// No eligible authenticated model means Exa, never another provider.
			const candidates = await resolveEffortCandidates(ctx, "quick", {
				includeParentModel: false,
				preferredProvider: backend,
			}).catch(() => []);
			const candidate = candidates.find(({ model }) => model.provider === backend);
			let reason: SearchFallbackReason = "unavailable";
			if (candidate) {
				const expectedApi =
					backend === "anthropic"
						? "anthropic-messages"
						: backend === "openai-codex"
							? "openai-codex-responses"
							: "openai-responses";
				if (candidate.model.api !== expectedApi) {
					reason = "unsupported";
				} else {
					try {
						nativeSignal.throwIfAborted();
						const sessionId = `${ctx.sessionManager.getSessionId()}:websearch:${backend}`;
						return await createHostedSearch(ctx, backend, candidate, sessionId).search(request, nativeSignal);
					} catch (error) {
						const message = error instanceof Error ? error.message.toLowerCase() : "";
						if (nativeDeadline.aborted) reason = "timeout";
						else if (/401|403|auth|credential/.test(message)) reason = "authentication";
						else if (/429|rate.limit|quota/.test(message)) reason = "rate-limit";
						else if (/unsupported|not supported/.test(message)) reason = "unsupported";
						else if (/web search|search event budget/.test(message)) reason = "search-failed";
						else reason = "provider-error";
					}
				}
			}
			fallback = { from: backend, reason };
		}
		overall.throwIfAborted();
		try {
			const result = await exa.search(request, overall);
			overall.throwIfAborted();
			return { ...result, fallback };
		} catch {
			overall.throwIfAborted();
			throw new Error("Web search failed: Exa is unavailable or returned an invalid result.");
		}
	};
}
