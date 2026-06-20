import { type ExtensionAPI, keyText, type Theme, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { setTauFooterItem } from "../../../src/shared/events.ts";

const COMMAND = "system-prompt-viewer";
const MESSAGE_TYPE = "tau.system-prompt-viewer.snapshot";
const FOOTER_ID = "system-prompt-viewer";

interface SnapshotDetails {
	content: string;
}

type Schema = Record<string, unknown> & {
	anyOf?: unknown;
	const?: unknown;
	description?: unknown;
	enum?: unknown;
	items?: unknown;
	oneOf?: unknown;
	properties?: unknown;
	required?: unknown;
	type?: unknown;
};

export default function systemPromptViewer(pi: ExtensionAPI): void {
	let enabled = false;

	function publishFooter(): void {
		setTauFooterItem(pi, {
			id: FOOTER_ID,
			priority: 30,
			text: enabled ? "system prompt" : undefined,
		});
	}

	pi.registerMessageRenderer(MESSAGE_TYPE, (message, { expanded }, theme) =>
		renderSnapshot(detailsContent(message.details), expanded, theme),
	);

	pi.registerCommand(COMMAND, {
		description: "Toggle automatic system prompt snapshots",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			publishFooter();
			ctx.ui.notify(`System prompt viewer ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!enabled) return;
		const activeTools = new Set(pi.getActiveTools());
		pi.sendMessage({
			customType: MESSAGE_TYPE,
			content: "",
			display: true,
			details: {
				content: formatSnapshot(
					ctx.getSystemPrompt(),
					pi.getAllTools().filter((tool) => activeTools.has(tool.name)),
				),
			} satisfies SnapshotDetails,
		});
	});

	pi.on("context", (event) => ({
		messages: event.messages.filter((message) => {
			if (!isRecord(message) || message.role !== "custom") return true;
			return message.customType !== MESSAGE_TYPE;
		}),
	}));

	pi.on("session_before_tree", (event, ctx) => {
		const entry = ctx.sessionManager.getEntry(event.preparation.targetId);
		if (entry?.type === "custom_message" && entry.customType === MESSAGE_TYPE) return { cancel: true };
	});

	pi.on("session_shutdown", () => {
		enabled = false;
		publishFooter();
	});
}

function renderSnapshot(content: string, expanded: boolean, theme: Theme): Box {
	const lineCount = content ? content.split("\n").length : 0;
	const header = expanded
		? `${theme.fg("accent", theme.bold("System prompt snapshot"))}${theme.fg("dim", ` (${keyText("app.tools.expand")} to collapse)`)}`
		: `${theme.fg("accent", theme.bold("System prompt snapshot"))}${theme.fg("dim", ` (${lineCount} lines, ${keyText("app.tools.expand")} to expand)`)}`;
	const box = new Box(1, 1, (value) => theme.bg("customMessageBg", value));
	box.addChild(new Text(expanded ? `${header}\n\n${content}` : header, 0, 0));
	return box;
}

function formatSnapshot(systemPrompt: string, activeTools: readonly ToolInfo[]): string {
	return [`# System prompt`, systemPrompt, `# Active tool schemas`, formatToolSchemas(activeTools)].join("\n\n");
}

function formatToolSchemas(tools: readonly ToolInfo[]): string {
	if (tools.length === 0) return "No active tools.";
	return tools.map(formatToolSchema).join("\n\n");
}

function formatToolSchema(tool: ToolInfo): string {
	const parameters = asSchema(tool.parameters);
	const properties = asSchema(parameters?.properties);
	const required = new Set(schemaStringArray(parameters?.required) ?? []);
	const header = `${tool.name} - ${tool.description}`;
	if (!properties) return `${header}\n  (no parameters)`;
	const names = Object.keys(properties);
	if (names.length === 0) return `${header}\n  (no parameters)`;
	return [
		header,
		...names.map((name) => {
			const property = asSchema(properties[name]);
			const presence = required.has(name) ? "required" : "optional";
			const description = typeof property?.description === "string" ? ` - ${property.description}` : "";
			return `  ${name}: ${formatSchemaType(property)} [${presence}]${description}`;
		}),
	].join("\n");
}

function formatSchemaType(schema: Schema | undefined): string {
	if (!schema) return "any";
	if ("const" in schema) return JSON.stringify(schema.const);
	const enumValues = schemaEnum(schema);
	if (enumValues) return enumValues.map((value) => JSON.stringify(value)).join(" | ");
	const variants = schemaArray(schema.anyOf) ?? schemaArray(schema.oneOf);
	if (variants) return variants.map(formatSchemaType).join(" | ");
	const items = asSchema(schema.items);
	if (items) return `${formatSchemaType(items)}[]`;
	const type = schema.type;
	if (Array.isArray(type)) return type.join(" | ");
	return typeof type === "string" ? type : "any";
}

function schemaEnum(schema: Schema): unknown[] | undefined {
	if (Array.isArray(schema.enum)) return schema.enum;
	const variants = schemaArray(schema.anyOf) ?? schemaArray(schema.oneOf);
	const values = variants?.map((variant) => variant.const);
	return values?.every((value) => value !== undefined) ? values : undefined;
}

function schemaArray(value: unknown): Schema[] | undefined {
	return Array.isArray(value) && value.every(isRecord) ? (value as Schema[]) : undefined;
}

function schemaStringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function asSchema(value: unknown): Schema | undefined {
	return isRecord(value) ? value : undefined;
}

function detailsContent(details: unknown): string {
	const content = (details as { content?: unknown } | undefined)?.content;
	return typeof content === "string" ? content : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
