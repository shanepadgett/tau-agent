type Language = "python3" | "node" | "deno";

interface StoredScript {
	language: Language;
	source: string;
}

export interface ScriptSourceStore {
	resolve(input: Record<string, unknown>): { scriptId: string | undefined; source: string };
	remember(scriptId: string, language: Language, source: string): void;
	forget(scriptId: string): void;
	approve(toolCallId: string, input: Record<string, unknown>): void;
	verifyAndConsume(toolCallId: string, input: Record<string, unknown>): void;
	clearApprovals(): void;
	clear(): void;
}

const MAX_STORED = 8;

export function createScriptSourceStore(): ScriptSourceStore {
	const scripts = new Map<string, StoredScript>();
	const approvals = new Map<string, string>();
	const store: ScriptSourceStore = {
		resolve(input) {
			const language = input.language;
			if (language !== "python3" && language !== "node" && language !== "deno") {
				throw new Error("Invalid script_runner language.");
			}
			const scriptId = input.scriptId;
			if (scriptId !== undefined && typeof scriptId !== "string") {
				throw new Error("Invalid scriptId.");
			}
			const edits = input.edits;
			if (edits !== undefined && !Array.isArray(edits)) throw new Error("Invalid script edits.");
			if (Array.isArray(edits) && edits.length > 0) {
				if (!scriptId) throw new Error("edits require scriptId from the failed run.");
				const stored = scripts.get(scriptId);
				if (!stored) throw new Error(`No stored script for scriptId ${scriptId}. Evicted; resend full script.`);
				if (stored.language !== language) {
					throw new Error(`Language mismatch: scriptId ${scriptId} is ${stored.language}, not ${language}.`);
				}
				let source = stored.source;
				for (const edit of edits) {
					if (
						!edit ||
						typeof edit !== "object" ||
						typeof edit.oldText !== "string" ||
						typeof edit.newText !== "string"
					) {
						throw new Error("Invalid script edit.");
					}
					const idx = source.indexOf(edit.oldText);
					if (idx === -1) throw new Error("edits oldText not found. Copy exact text from the script you wrote.");
					source = source.slice(0, idx) + edit.newText + source.slice(idx + edit.oldText.length);
				}
				return { scriptId, source };
			}
			if (typeof input.script !== "string" || (input.script.length === 0 && !scriptId)) {
				throw new Error("Provide script, or edits + scriptId.");
			}
			return { scriptId, source: input.script };
		},
		remember(scriptId, language, source) {
			scripts.set(scriptId, { language, source });
			while (scripts.size > MAX_STORED) {
				const oldest = scripts.keys().next().value;
				if (oldest === undefined) break;
				scripts.delete(oldest);
			}
		},
		forget(scriptId) {
			scripts.delete(scriptId);
		},
		approve(toolCallId, input) {
			approvals.set(toolCallId, JSON.stringify(input));
		},
		verifyAndConsume(toolCallId, input) {
			const approved = approvals.get(toolCallId);
			if (approved === undefined) return;
			approvals.delete(toolCallId);
			if (approved !== JSON.stringify(input)) {
				throw new Error("script_runner request changed after approval; blocked.");
			}
		},
		clearApprovals() {
			approvals.clear();
		},
		clear() {
			scripts.clear();
			approvals.clear();
		},
	};
	return store;
}
