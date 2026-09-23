import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { emitTauEvent, onTauEventImmediately, type TauAgentEvents } from "./events.ts";

type PromptSource = Parameters<TauAgentEvents["tau:prompt.sources"]["accept"]>[0];

export type PromptValue = Pick<PromptSource, "key" | "section" | "refresh"> & { text: string };

export function collectPromptSources(pi: ExtensionAPI): PromptSource[] {
	const sources: PromptSource[] = [];
	emitTauEvent(pi, "tau:prompt.sources", { accept: (source) => sources.push(source) });
	const keys = new Set<string>();
	for (const source of sources) {
		if (keys.has(source.key)) throw new Error(`Duplicate prompt source: ${source.key}`);
		keys.add(source.key);
	}
	return sources.sort((a, b) => a.key.localeCompare(b.key, "en"));
}

export function registerPromptSource(pi: ExtensionAPI, source: PromptSource): void {
	if (!/^[a-z][a-z0-9/-]*$/.test(source.key) || !/^[a-z][a-z0-9-]*$/.test(source.section)) {
		throw new Error(`Invalid prompt source: ${source.key}`);
	}
	onTauEventImmediately(pi, `prompt.${source.key}`, "tau:prompt.sources", ({ accept }) => accept(source));
}
