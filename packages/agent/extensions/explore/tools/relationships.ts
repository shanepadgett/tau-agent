import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncateBoundedHead } from "../../../shared/bounded-text-result.ts";
import type { ToolRowStateStore } from "../../../shared/tool-row-state.ts";
import type { ExploreEngine } from "../../../src/ast/engine.ts";
import { formatRelationshipResult } from "../../../src/ast/format/relationships.ts";
import type { ExploreFileGraph } from "../../../src/ast/graph/file-graph.ts";
import { queryRelationships, type RelationshipOp } from "../../../src/ast/graph/relationships.ts";
import { stripLeadingAt } from "../../../src/ast/traverse.ts";
import { ExploreCallComponent, renderExploreResult, type ExploreToolDetails } from "./render.ts";
import { targetParams } from "./target-params.ts";

const relationshipParams = Type.Object(
	{
		...targetParams,
		resultLimit: Type.Integer({ minimum: 1, maximum: 100, description: "Max sites (1–100)" }),
	},
	{ additionalProperties: false },
);

function createRelationshipTool(
	op: RelationshipOp,
	description: string,
	promptSnippet: string,
	promptGuidelines: string[],
	rowState: ToolRowStateStore,
	engineFor: (cwd: string) => ExploreEngine,
	graphFor: (cwd: string) => ExploreFileGraph,
) {
	return defineTool<typeof relationshipParams, ExploreToolDetails>({
		name: op,
		label: op,
		description,
		promptSnippet,
		promptGuidelines,
		parameters: relationshipParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const engine = engineFor(ctx.cwd);
			const graph = graphFor(ctx.cwd);
			const abort = signal ?? new AbortController().signal;
			const result = await queryRelationships({
				engine,
				graph,
				scopePath: params.path,
				op,
				targetPath: params.targetPath,
				name: params.name,
				line: params.line,
				resultLimit: params.resultLimit,
				signal: abort,
			});
			const text = formatRelationshipResult(result, engine.cwd);
			const bounded = truncateBoundedHead(text);
			const siteCount = result.kind === "resolved" ? result.sites.length : 0;
			return {
				content: [{ type: "text", text: bounded.content }],
				details: {
					declarationCount: siteCount,
					returnedBytes: Buffer.byteLength(bounded.content),
					truncated: bounded.truncated,
				},
			};
		},
		renderCall(args, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			const name = args.name ?? "?";
			const scope = stripLeadingAt(args.path ?? "");
			const pin = args.targetPath !== undefined ? stripLeadingAt(args.targetPath) : "";
			const targets = pin.length > 0 ? [`${name} @ ${pin}`] : [name];
			const options = [`[scope=${scope} limit=${args.resultLimit ?? "?"}]`];
			const component =
				(context.lastComponent as ExploreCallComponent | undefined) ??
				new ExploreCallComponent(rowState, context.toolCallId, op, targets, options, theme);
			component.targetVariants = targets;
			component.optionVariants = options;
			component.theme = theme;
			return component;
		},
		renderResult(result, options, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			return renderExploreResult(result, options.expanded, theme, context);
		},
	});
}

export function createCallersTool(
	rowState: ToolRowStateStore,
	engineFor: (cwd: string) => ExploreEngine,
	graphFor: (cwd: string) => ExploreFileGraph,
) {
	return createRelationshipTool(
		"callers",
		"Inbound syntactic sites for one decl (calls/constructs/implementors for types). Scope is a directory. Ambiguous name → candidate list, not sites. Soft-errors return as text.",
		"Inbound call/construct sites",
		[
			"Disambiguate with targetPath or line before acting on hits.",
			"Respect certainty: exact silent; inferred/ambiguous labeled; ambiguous not actionable.",
		],
		rowState,
		engineFor,
		graphFor,
	);
}

export function createCalleesTool(
	rowState: ToolRowStateStore,
	engineFor: (cwd: string) => ExploreEngine,
	graphFor: (cwd: string) => ExploreFileGraph,
) {
	return createRelationshipTool(
		"callees",
		"Direct outbound sites inside one decl body (heritage ancestors for types). One hop only. Same resolve/soft-error protocol as callers.",
		"Direct callees / heritage",
		[],
		rowState,
		engineFor,
		graphFor,
	);
}

export function createReferencesTool(
	rowState: ToolRowStateStore,
	engineFor: (cwd: string) => ExploreEngine,
	graphFor: (cwd: string) => ExploreFileGraph,
) {
	return createRelationshipTool(
		"references",
		"Direct references: calls, constructs, imports/re-exports, heritage mentions. Not a full rename set. Same resolve/soft-error protocol as callers.",
		"Direct references to a symbol",
		["Certainty labels are incomplete for rename — verify before bulk edit."],
		rowState,
		engineFor,
		graphFor,
	);
}

export function createImplementationsTool(
	rowState: ToolRowStateStore,
	engineFor: (cwd: string) => ExploreEngine,
	graphFor: (cwd: string) => ExploreFileGraph,
) {
	return createRelationshipTool(
		"implementations",
		"Heritage implementors of a type, or same-name methods on extending types (conservative). Same resolve/soft-error protocol as callers.",
		"Implementors / overrides",
		["Method matches are name-based on subtype owners — not semantic override resolution."],
		rowState,
		engineFor,
		graphFor,
	);
}
