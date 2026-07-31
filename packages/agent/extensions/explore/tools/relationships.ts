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
		resultLimit: Type.Integer({ minimum: 1, maximum: 100, description: "Max sites to return" }),
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
		"Syntactic call sites of a declaration. For types: constructions and implementors.",
		"Find callers of a symbol",
		[
			"Use after selecting a change target when inbound uses affect the plan.",
			"Disambiguate with targetPath or line when the name is common.",
			"Treat ambiguous sites as non-actionable until tightened.",
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
		"Direct callees inside a declaration body. For types: ancestor types from heritage.",
		"Find callees of a symbol",
		["Direct only — no depth parameter.", "Use to skim outbound dependencies before editing a body."],
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
		"Direct references: calls, constructions, imports, and heritage mentions of a declaration.",
		"Find references to a symbol",
		[
			"Includes import and re-export-style bindings when classified.",
			"Not a full IDE rename set — respect certainty labels.",
		],
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
		"Syntactic inheritance/implementation sites and conservative same-name overrides.",
		"Find implementations of a type or method",
		[
			"For types: heritage clauses naming the target.",
			"For methods: same-name methods on types that extend/implement the owner (conservative).",
		],
		rowState,
		engineFor,
		graphFor,
	);
}
