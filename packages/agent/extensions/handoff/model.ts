import type { Tool } from "@earendil-works/pi-ai";
import { posix } from "node:path";
import { Type } from "typebox";

export interface HandoffDraft {
	prompt: string;
	files: string[];
}

export const HANDOFF_TOOL = {
	name: "submit_handoff",
	description: "Submit the prompt and project files for the new chat. This is the only allowed response.",
	parameters: Type.Object(
		{
			prompt: Type.String({ description: "Self-contained opening prompt for the new chat" }),
			files: Type.Array(
				Type.String({ description: "Project-relative file path already known from the current conversation" }),
				{ description: "Focused files Tau should autoread in the new chat" },
			),
		},
		{ additionalProperties: false },
	),
} satisfies Tool;

export function buildHandoffRequest(conversation: string, goal: string, cwd: string): string {
	return [
		"You prepare a handoff from the current coding chat into a fresh chat.",
		`Call ${HANDOFF_TOOL.name} exactly once. Write no prose outside the tool call.`,
		"",
		"Build the handoff only from the supplied conversation and goal. Do not research, invent findings, or assume file contents that are absent from the conversation.",
		"The prompt must give the new agent the relevant decisions, progress, constraints, unresolved questions, and exact next task.",
		"Keep it focused. The selected files will be autoread separately, so summarize why they matter without copying their contents into the prompt.",
		`Every file must be a path under ${cwd}, relative to that directory, and must already be known from the conversation. Return only files relevant to the goal.`,
		"Return an empty files array when no known file is clearly relevant.",
		"",
		"## Handoff goal",
		goal,
		"",
		"## Current effective conversation",
		conversation,
	].join("\n");
}

export function handoffDraftFromToolInput(input: unknown): HandoffDraft {
	if (!input || typeof input !== "object") throw new Error("Handoff output must be an object.");
	const record = input as Record<string, unknown>;
	if (typeof record.prompt !== "string" || !record.prompt.trim()) {
		throw new Error("Handoff prompt must be a non-empty string.");
	}
	if (!Array.isArray(record.files) || !record.files.every((path) => typeof path === "string")) {
		throw new Error("Handoff files must be an array of strings.");
	}

	const files: string[] = [];
	for (const rawPath of record.files) {
		const path = posix.normalize(rawPath.trim().replace(/^@/, "").replace(/^\.\//, ""));
		if (
			path === "." ||
			path.startsWith("/") ||
			/^[a-z]:\//i.test(path) ||
			path === ".." ||
			path.startsWith("../") ||
			path.includes("\\")
		) {
			throw new Error(`Handoff file must be a project-relative path: ${rawPath}`);
		}
		if (!files.includes(path)) files.push(path);
	}

	return { prompt: record.prompt.trim(), files };
}
