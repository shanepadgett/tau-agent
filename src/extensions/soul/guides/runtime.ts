import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";

const ROK_GUIDE_MESSAGE_TYPE = "tau:soul.guide";
const ROK_GUIDE_MARKER_TYPE = "tau:soul.marker";
const ROK_GUIDE_CONTROL_TYPE = "tau:soul.guide-control";

type MarkerAction = "enabled" | "disabled";

export interface GuideDefinition {
	kind: string;
	verb: string;
	description: string;
	text: string;
}

interface GuideDetails extends GuideMarkerSource {
	guideId: string;
}

interface GuideMarkerSource {
	guideKind: string;
	verb: string;
}

interface GuideMarkerDetails extends GuideMarkerSource {
	action: MarkerAction;
	modelContext: false;
}

interface GuideControl {
	action: "disable";
	guideId: string;
	guideKind: string;
}

export interface ActiveGuide extends GuideDetails {
	content: string;
}

export function registerGuideCommands(
	pi: ExtensionAPI,
	guides: readonly GuideDefinition[],
	isEnabled: () => boolean,
	updateFooter: (verb: string | undefined) => void,
): void {
	for (const guide of guides) {
		pi.registerCommand(guide.kind, {
			description: guide.description,
			handler: async (args, ctx) => {
				if (!isEnabled()) {
					ctx.ui.notify("Soul is disabled", "warning");
					return;
				}
				const prompt = args.trim() || undefined;
				await runGuideCommand(pi, guide, prompt, ctx, updateFooter);
			},
		});
	}
}

export function deriveActiveGuide(entries: readonly SessionEntry[]): ActiveGuide | undefined {
	let active: ActiveGuide | undefined;
	const disabled = new Set<string>();

	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === ROK_GUIDE_CONTROL_TYPE) {
			const control = readGuideControl(entry.data);
			if (control) {
				disabled.add(control.guideId);
				if (active?.guideId === control.guideId) active = undefined;
			}
			continue;
		}

		if (entry.type !== "custom_message" || entry.customType !== ROK_GUIDE_MESSAGE_TYPE) continue;
		if (typeof entry.content !== "string") continue;
		const details = readGuideDetails(entry.details);
		if (!details || disabled.has(details.guideId)) continue;
		active = { ...details, content: entry.content };
	}

	return active;
}

export function filterGuideMessages<T extends { role: string; customType?: string; details?: unknown }>(
	messages: readonly T[],
	active: ActiveGuide | undefined,
): T[] {
	return messages.filter((message) => {
		if (message.role !== "custom") return true;
		if (message.customType === ROK_GUIDE_MARKER_TYPE) return false;
		if (message.customType !== ROK_GUIDE_MESSAGE_TYPE) return true;
		const details = readGuideDetails(message.details);
		return Boolean(active && details && details.guideId === active.guideId);
	});
}

async function runGuideCommand(
	pi: ExtensionAPI,
	target: GuideDefinition,
	prompt: string | undefined,
	ctx: ExtensionCommandContext,
	updateFooter: (verb: string | undefined) => void,
): Promise<void> {
	const active = deriveActiveGuide(ctx.sessionManager.getBranch());

	if (!prompt && active?.guideKind === target.kind) {
		appendDisable(pi, active);
		appendMarker(pi, active, "disabled");
		updateFooter(undefined);
		return;
	}

	if (active && active.guideKind !== target.kind) {
		appendDisable(pi, active);
		appendMarker(pi, active, "disabled");
	}

	if (active?.guideKind !== target.kind) {
		pi.sendMessage<GuideDetails>({
			customType: ROK_GUIDE_MESSAGE_TYPE,
			content: target.text,
			display: false,
			details: { guideId: randomUUID(), guideKind: target.kind, verb: target.verb },
		});
		appendMarker(pi, { guideKind: target.kind, verb: target.verb }, "enabled");
	}
	updateFooter(target.verb);

	if (prompt) pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
}

function appendMarker(pi: ExtensionAPI, source: GuideMarkerSource, action: MarkerAction): void {
	pi.sendMessage<GuideMarkerDetails>({
		customType: ROK_GUIDE_MARKER_TYPE,
		content: `${source.verb} ${action}`,
		display: true,
		details: { ...source, action, modelContext: false },
	});
}

function appendDisable(pi: ExtensionAPI, active: ActiveGuide): void {
	pi.appendEntry<GuideControl>(ROK_GUIDE_CONTROL_TYPE, {
		action: "disable",
		guideId: active.guideId,
		guideKind: active.guideKind,
	});
}

function readGuideDetails(value: unknown): GuideDetails | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.guideId !== "string") return undefined;
	if (typeof record.guideKind !== "string") return undefined;
	if (typeof record.verb !== "string") return undefined;
	return { guideId: record.guideId, guideKind: record.guideKind, verb: record.verb };
}

function readGuideControl(value: unknown): GuideControl | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (record.action !== "disable") return undefined;
	if (typeof record.guideId !== "string") return undefined;
	if (typeof record.guideKind !== "string") return undefined;
	return { action: "disable", guideId: record.guideId, guideKind: record.guideKind };
}
