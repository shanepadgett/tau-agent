import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { emitTauEvent, onTauEvent } from "./events.js";

export interface OutlineInjectionDetails {
	v: 1;
	rowId: string;
	path: string;
	cwd: string;
	batchId: string;
}

export interface PreparedOutlineInjection {
	customType: "tau.explore.outline";
	content: string;
	display: true;
	details: OutlineInjectionDetails;
}

export interface OutlineInjectionRequest {
	cwd: string;
	batchId: string;
	paths: readonly string[];
	signal: AbortSignal | undefined;
	isLifecycleCurrent(): boolean;
}

export interface OutlineInjectionResponse {
	messages: PreparedOutlineInjection[];
	warnings: string[];
}

export type OutlineInjectionProvider = (request: OutlineInjectionRequest) => Promise<OutlineInjectionResponse>;

export function registerOutlineInjectionProvider(pi: ExtensionAPI, provider: OutlineInjectionProvider): () => void {
	return onTauEvent(pi, "shared.outline-injection-provider", "tau:outline-injection.requested", (event) => {
		event.accept(provider(event.request));
	});
}

export async function requestOutlineInjections(
	pi: Pick<ExtensionAPI, "events">,
	request: OutlineInjectionRequest,
): Promise<OutlineInjectionResponse> {
	let response: Promise<OutlineInjectionResponse> | undefined;
	emitTauEvent(pi, "tau:outline-injection.requested", {
		request,
		accept(candidate) {
			response ??= candidate;
		},
	});
	if (response) return response;
	return {
		messages: [],
		warnings: request.paths.map((path) => `${path}: Explore outline provider is unavailable`),
	};
}
