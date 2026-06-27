import { defineTool, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { type SearchEvidenceDetails, withSearchEvidence } from "./evidence.ts";
import { formatStatus, type SearchRenderState, toolHeader } from "./render-state.ts";

const forgetParams = Type.Object({
	keep: Type.String({ description: "Short checkpoint to retain after cleanup; include only facts needed next turn." }),
	paths: Type.Optional(Type.Array(Type.Object({ path: Type.String(), rereadIf: Type.Optional(Type.String()) }))),
	recent: Type.Optional(Type.Number()),
	disposition: Type.Optional(Type.Union([Type.Literal("done"), Type.Literal("irrelevant")])),
});

type ForgetParams = Static<typeof forgetParams>;
export interface ForgetDetails extends SearchEvidenceDetails {
	searchMemory: {
		version: 1;
		type: "forget";
		paths?: Array<{ path: string; rereadIf?: string }>;
		recent?: number;
		disposition: "done" | "irrelevant";
	};
}

export function registerForgetTool(pi: ExtensionAPI, renderState: SearchRenderState, isEnabled: () => boolean): void {
	pi.registerTool(
		defineTool<typeof forgetParams, ForgetDetails>({
			name: "forget",
			label: "Forget",
			description: "Retain a short checkpoint and mark prior successful search evidence forgotten or irrelevant.",
			promptSnippet: "forget old search evidence while keeping a short checkpoint",
			promptGuidelines: [
				"Use forget with disposition done for successful exploration that has served its purpose.",
				"Use forget with disposition irrelevant for dead-end/no-value exploration.",
				"Include concrete rereadIf for path evidence.",
				"Never forget user requirements, active decisions, mutation results, failed checks, or unresolved errors.",
			],
			parameters: forgetParams,
			executionMode: "sequential",
			async execute(toolCallId, params) {
				if (!isEnabled())
					return {
						content: [{ type: "text", text: "forget unavailable: search.workingMemory is false" }],
						details: {
							searchEvidence: {
								version: 1,
								kind: "forget",
								role: "memory-action",
								paths: [],
								complete: false,
								toolCallId,
							},
							searchMemory: { version: 1, type: "forget", disposition: "done" },
						},
						isError: true,
					};
				const paths = params.paths
					?.filter((entry) => entry.path.trim())
					.map((entry) => ({
						path: entry.path.trim(),
						...(entry.rereadIf?.trim() ? { rereadIf: entry.rereadIf.trim() } : {}),
					}));
				const disposition = params.disposition ?? "done";
				return {
					content: [{ type: "text", text: `Search memory retained:\n${params.keep}` }],
					details: {
						...withSearchEvidence(undefined, {
							version: 1,
							kind: "forget",
							role: "memory-action",
							paths: paths?.map((entry) => entry.path) ?? [],
							complete: true,
							toolCallId,
						}),
						searchMemory: {
							version: 1,
							type: "forget",
							...(paths && paths.length > 0 ? { paths } : {}),
							...(typeof params.recent === "number" ? { recent: params.recent } : {}),
							disposition,
						},
					},
				};
			},
			renderCall(args, theme, context) {
				return new ForgetCall(args, theme, context.toolCallId, renderState);
			},
		}),
	);
}

export function parseForgetDetails(details: unknown): ForgetDetails["searchMemory"] | undefined {
	if (typeof details !== "object" || details === null || !("searchMemory" in details)) return undefined;
	const memory = (details as { searchMemory?: unknown }).searchMemory;
	if (typeof memory !== "object" || memory === null) return undefined;
	const record = memory as Record<string, unknown>;
	if (record.version !== 1 || record.type !== "forget") return undefined;
	const disposition = record.disposition === "irrelevant" ? "irrelevant" : "done";
	return {
		version: 1,
		type: "forget",
		...(Array.isArray(record.paths) ? { paths: record.paths as Array<{ path: string; rereadIf?: string }> } : {}),
		...(typeof record.recent === "number" ? { recent: record.recent } : {}),
		disposition,
	};
}

class ForgetCall implements Component {
	private readonly args: ForgetParams;
	private readonly theme: Theme;
	private readonly toolCallId: string;
	private readonly state: SearchRenderState;

	constructor(args: ForgetParams, theme: Theme, toolCallId: string, state: SearchRenderState) {
		this.args = args;
		this.theme = theme;
		this.toolCallId = toolCallId;
		this.state = state;
	}
	render(width: number): string[] {
		return wrapTextWithAnsi(
			`${toolHeader(this.theme, "forget")}${formatStatus(this.theme, this.state, this.toolCallId)} ${this.theme.fg("muted", this.args.disposition ?? "done")}`,
			width,
		);
	}
	invalidate(): void {}
}
