import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const INJECTED_CONTEXT_TYPE = "tau.injected-context";

export interface InjectedContextDetails {
	source: "review" | "tau-edit";
	title?: string;
}

export interface InjectedContext {
	content: string;
	details: InjectedContextDetails;
}

export interface InjectedContextMessage {
	customType: typeof INJECTED_CONTEXT_TYPE;
	content: string;
	display: false;
	details: InjectedContextDetails;
}

const pending: InjectedContextMessage[] = [];
const emittedThisTurn: InjectedContextMessage[] = [];

export function createInjectedContext(content: string, details: InjectedContextDetails): InjectedContextMessage {
	return { customType: INJECTED_CONTEXT_TYPE, content, display: false, details };
}

export function queueInjectedContext(content: string, details: InjectedContextDetails): void {
	pending.push(createInjectedContext(content, details));
}

export function shiftPendingInjectedContext(): InjectedContextMessage | undefined {
	const message = pending.shift();
	if (message) emittedThisTurn.push(message);
	return message;
}

export function getPendingInjectedContexts(): InjectedContext[] {
	return [...pending, ...emittedThisTurn].map(({ content, details }) => ({ content, details }));
}

export function clearEmittedInjectedContexts(): void {
	emittedThisTurn.length = 0;
}

export function clearPendingInjectedContexts(): void {
	pending.length = 0;
	emittedThisTurn.length = 0;
}

export function getBranchInjectedContexts(entries: readonly SessionEntry[]): InjectedContext[] {
	return entries.flatMap((entry) => {
		if (entry.type !== "custom_message" || entry.customType !== INJECTED_CONTEXT_TYPE) return [];
		if (typeof entry.content !== "string") return [];
		const details = readDetails(entry.details);
		return details ? [{ content: entry.content, details }] : [];
	});
}

function readDetails(value: unknown): InjectedContextDetails | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (record.source !== "review" && record.source !== "tau-edit") return undefined;
	return {
		source: record.source,
		...(typeof record.title === "string" ? { title: record.title } : {}),
	};
}
