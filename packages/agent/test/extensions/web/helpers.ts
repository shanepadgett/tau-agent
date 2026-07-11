import { extensionContext as createExtensionContext } from "../explore/helpers.ts";

export { renderedText, renderContext, testRowState, testTheme } from "../explore/helpers.ts";

export interface FetchCallInit {
	headers?: Headers | Record<string, string> | Array<[string, string]>;
	body?: unknown;
	signal?: AbortSignal | null;
}

export const extensionContext = createExtensionContext(process.cwd());

export function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((item) => item.type === "text")?.text ?? "";
}

export function waitForAbort(signal: AbortSignal | null | undefined): Promise<never> {
	return new Promise((_resolve, reject) => {
		if (!signal) return;
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}
