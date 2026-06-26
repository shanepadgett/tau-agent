import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const ROK_MODE_MESSAGE_TYPE = "tau:soul.mode";
const ROK_MODE_MARKER_TYPE = "tau:soul.marker";
const ROK_MODE_CONTROL_TYPE = "tau:soul.mode-control";

type MarkerAction = "enabled" | "disabled";

export interface ModeDefinition {
	kind: string;
	verb: string;
	description: string;
	text: string;
}

interface ModeDetails {
	modeId: string;
	modeKind: string;
	verb: string;
}

interface ModeControl {
	action: "disable";
	modeId: string;
}

export interface ActiveMode extends ModeDetails {
	content: string;
}

export function registerModeMessageRenderers(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(ROK_MODE_MARKER_TYPE, (message, _options, theme) => {
		if (typeof message.content !== "string") return undefined;
		const label = `${message.content.slice(0, 1).toUpperCase()}${message.content.slice(1)}`;
		return {
			render: (width) => [truncateToWidth(theme.bold(label), width)],
			invalidate: () => {},
		};
	});
}

export function registerModeCommands(
	pi: ExtensionAPI,
	modes: readonly ModeDefinition[],
	isEnabled: () => boolean,
	updateFooter: (verb: string | undefined) => void,
): void {
	for (const mode of modes) {
		pi.registerCommand(mode.kind, {
			description: mode.description,
			handler: async (args, ctx) => {
				if (!isEnabled()) {
					ctx.ui.notify("Soul is disabled", "warning");
					return;
				}
				const prompt = args.trim() || undefined;
				await runModeCommand(pi, mode, prompt, ctx, updateFooter);
			},
		});
	}
}

export function deriveActiveMode(entries: readonly SessionEntry[]): ActiveMode | undefined {
	let active: ActiveMode | undefined;
	const disabled = new Set<string>();

	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === ROK_MODE_CONTROL_TYPE) {
			const control = readModeControl(entry.data);
			if (control) {
				disabled.add(control.modeId);
				if (active?.modeId === control.modeId) active = undefined;
			}
			continue;
		}

		if (entry.type !== "custom_message" || entry.customType !== ROK_MODE_MESSAGE_TYPE) continue;
		if (typeof entry.content !== "string") continue;
		const details = readModeDetails(entry.details);
		if (!details || disabled.has(details.modeId)) continue;
		active = { ...details, content: entry.content };
	}

	return active;
}

export function filterModeMessages<T extends { role: string; customType?: string; details?: unknown }>(
	messages: readonly T[],
	active: ActiveMode | undefined,
): T[] {
	return messages.filter((message) => {
		if (message.role !== "custom") return true;
		if (message.customType === ROK_MODE_MARKER_TYPE) return false;
		if (message.customType !== ROK_MODE_MESSAGE_TYPE) return true;
		const details = readModeDetails(message.details);
		return Boolean(active && details && details.modeId === active.modeId);
	});
}

async function runModeCommand(
	pi: ExtensionAPI,
	target: ModeDefinition,
	prompt: string | undefined,
	ctx: ExtensionCommandContext,
	updateFooter: (verb: string | undefined) => void,
): Promise<void> {
	const active = deriveActiveMode(ctx.sessionManager.getBranch());

	if (!prompt && active?.modeKind === target.kind) {
		appendDisable(pi, active);
		appendMarker(pi, active.verb, "disabled");
		updateFooter(undefined);
		return;
	}

	if (active && active.modeKind !== target.kind) {
		appendDisable(pi, active);
		appendMarker(pi, active.verb, "disabled");
	}

	if (active?.modeKind !== target.kind) {
		pi.sendMessage<ModeDetails>({
			customType: ROK_MODE_MESSAGE_TYPE,
			content: target.text,
			display: false,
			details: { modeId: randomUUID(), modeKind: target.kind, verb: target.verb },
		});
		appendMarker(pi, target.verb, "enabled");
	}
	updateFooter(target.verb);

	if (prompt) pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
}

function appendMarker(pi: ExtensionAPI, verb: string, action: MarkerAction): void {
	pi.sendMessage({ customType: ROK_MODE_MARKER_TYPE, content: `${verb} ${action}`, display: true });
}

function appendDisable(pi: ExtensionAPI, active: ActiveMode): void {
	pi.appendEntry<ModeControl>(ROK_MODE_CONTROL_TYPE, {
		action: "disable",
		modeId: active.modeId,
	});
}

function readModeDetails(value: unknown): ModeDetails | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.modeId !== "string") return undefined;
	if (typeof record.modeKind !== "string") return undefined;
	if (typeof record.verb !== "string") return undefined;
	return { modeId: record.modeId, modeKind: record.modeKind, verb: record.verb };
}

function readModeControl(value: unknown): ModeControl | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (record.action !== "disable") return undefined;
	if (typeof record.modeId !== "string") return undefined;
	return { action: "disable", modeId: record.modeId };
}
