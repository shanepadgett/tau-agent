import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Marker } from "@shanepadgett/tau-tui";
import { BoundedTextResultBuilder } from "../../shared/bounded-text-result.ts";
import {
	registerOutlineInjectionProvider,
	type OutlineInjectionDetails,
	type PreparedOutlineInjection,
} from "../../shared/outline-injection.ts";
import type { TemporaryOutputStore } from "../../shared/temporary-output-store.ts";
import type { ToolRowStateStore } from "../../shared/tool-row-state.ts";
import type { ExploreEngine } from "./ast/engine.ts";
import { formatOutlineEmpty, formatOutlineFile } from "./ast/format/outline.ts";
import { outlinePath } from "./ast/queries/outline.ts";
import { formatPathForDisplay, stripLeadingAt } from "./traverse.ts";

const OPTIONS = { includePrivate: false, includeDocs: false, names: [] as readonly string[] };

export function registerExploreOutlineInjection(
	pi: ExtensionAPI,
	rowState: ToolRowStateStore,
	temporaryOutput: TemporaryOutputStore,
	engineFor: (cwd: string) => ExploreEngine,
): void {
	registerOutlineInjectionProvider(pi, async (request) => {
		const messages: PreparedOutlineInjection[] = [];
		const warnings: string[] = [];
		const engine = engineFor(request.cwd);
		for (let index = 0; index < request.paths.length; index += 1) {
			const path = stripLeadingAt(request.paths[index] ?? "");
			assertCurrent(request.signal, request.isLifecycleCurrent);
			try {
				const abort = request.signal ?? new AbortController().signal;
				const result = await outlinePath(engine, path, OPTIONS, abort);
				if (result.mode !== "file") throw new Error("Working-memory outlines require a file path");
				const body =
					result.file.rows.length === 0
						? formatOutlineEmpty(OPTIONS.names)
						: formatOutlineFile(result.file, engine.cwd, false);
				const builder = new BoundedTextResultBuilder(temporaryOutput, "completeBlocks");
				let content: string;
				try {
					await builder.appendBlock(
						result.file.path,
						formatPathForDisplay(result.file.path, engine.cwd),
						`${path}\n${body}`,
					);
					assertCurrent(request.signal, request.isLifecycleCurrent);
					content = (await builder.finish()).content;
				} catch (error) {
					await builder.abort();
					throw error;
				}
				messages.push({
					customType: "tau.explore.outline" as const,
					content,
					display: true as const,
					details: {
						v: 1 as const,
						rowId: `${request.batchId}:${index}`,
						path,
						cwd: request.cwd,
						batchId: request.batchId,
					},
				});
			} catch (error) {
				if (request.signal?.aborted || !request.isLifecycleCurrent()) throw error;
				warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return { messages, warnings };
	});

	pi.registerMessageRenderer<OutlineInjectionDetails>("tau.explore.outline", (message, options, theme) => {
		const details = parseDetails(message.details);
		if (!details) return undefined;
		return new OutlineMessageComponent(
			rowState,
			details.rowId,
			details.path,
			typeof message.content === "string" ? message.content : "",
			options.expanded,
			theme,
		);
	});
}

function assertCurrent(signal: AbortSignal | undefined, isLifecycleCurrent: () => boolean): void {
	signal?.throwIfAborted();
	if (!isLifecycleCurrent()) throw new Error("Outline preparation crossed a session lifecycle boundary");
}

function parseDetails(value: unknown): OutlineInjectionDetails | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const details = value as Record<string, unknown>;
	if (
		details.v !== 1 ||
		typeof details.rowId !== "string" ||
		typeof details.path !== "string" ||
		typeof details.cwd !== "string" ||
		typeof details.batchId !== "string"
	) {
		return undefined;
	}
	return {
		v: 1,
		rowId: details.rowId,
		path: details.path,
		cwd: details.cwd,
		batchId: details.batchId,
	};
}

class OutlineMessageComponent {
	private readonly rowState: ToolRowStateStore;
	private readonly rowId: string;
	private readonly path: string;
	private readonly content: string;
	private readonly expanded: boolean;
	private readonly theme: Theme;

	constructor(
		rowState: ToolRowStateStore,
		rowId: string,
		path: string,
		content: string,
		expanded: boolean,
		theme: Theme,
	) {
		this.rowState = rowState;
		this.rowId = rowId;
		this.path = path;
		this.content = content;
		this.expanded = expanded;
		this.theme = theme;
		this.rowState.watch(this.rowId, () => this.invalidate());
	}

	render(width: number): string[] {
		const marker = new Marker({
			theme: this.theme,
			state: this.rowState.get(this.rowId) === "pruned" ? "warning" : "complete",
			label: "outline",
			parts: [this.path],
		}).render(width);
		if (!this.expanded) return marker;
		return [...marker, ...new Text(this.theme.fg("dim", this.content), 1, 0).render(width)];
	}

	invalidate(): void {}
}
