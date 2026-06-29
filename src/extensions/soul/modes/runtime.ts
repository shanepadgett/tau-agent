import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const ROK_MODE_CONTEXT_TYPE = "tau:soul.mode-context";
const LEGACY_ROK_MODE_MESSAGE_TYPE = "tau:soul.mode";
const ROK_MODE_MARKER_TYPE = "tau:soul.marker";
const ROK_MODE_STATE_TYPE = "tau:soul.mode-state";

type MarkerAction = "enabled" | "disabled";

export interface ModeDefinition {
	kind: string;
	verb: string;
	description: string;
	text: string;
}

interface ModeState {
	modeKind: string | null;
}

export interface ActiveMode {
	modeKind: string;
	verb: string;
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
				await runModeCommand(pi, modes, mode, prompt, ctx, updateFooter);
			},
		});
	}
}

export function deriveActiveMode(
	entries: readonly SessionEntry[],
	modes: readonly ModeDefinition[],
): ActiveMode | undefined {
	const modesByKind = new Map(modes.map((mode) => [mode.kind, mode]));
	let active: ActiveMode | undefined;

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ROK_MODE_STATE_TYPE) continue;
		const state = readModeState(entry.data);
		if (!state) continue;

		if (state.modeKind === null) {
			active = undefined;
			continue;
		}

		const mode = modesByKind.get(state.modeKind);
		active = mode ? { modeKind: mode.kind, verb: mode.verb, content: mode.text } : undefined;
	}

	return active;
}

export function applyActiveModeContext(
	messages: ContextEvent["messages"],
	active: ActiveMode | undefined,
): ContextEvent["messages"] {
	const filtered = messages.filter((message) => {
		if (message.role !== "custom") return true;
		return !isSoulModeMessageType(message.customType);
	});

	if (!active) return filtered;
	return [createModeContextMessage(active), ...filtered];
}

async function runModeCommand(
	pi: ExtensionAPI,
	modes: readonly ModeDefinition[],
	target: ModeDefinition,
	prompt: string | undefined,
	ctx: ExtensionCommandContext,
	updateFooter: (verb: string | undefined) => void,
): Promise<void> {
	const active = deriveActiveMode(ctx.sessionManager.getBranch(), modes);

	if (!prompt && active?.modeKind === target.kind) {
		appendModeState(pi, null);
		appendMarker(pi, active.verb, "disabled");
		updateFooter(undefined);
		return;
	}

	if (active && active.modeKind !== target.kind) appendMarker(pi, active.verb, "disabled");

	if (active?.modeKind !== target.kind) {
		appendModeState(pi, target.kind);
		appendMarker(pi, target.verb, "enabled");
	}
	updateFooter(target.verb);

	if (prompt) pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
}

function appendMarker(pi: ExtensionAPI, verb: string, action: MarkerAction): void {
	pi.sendMessage({ customType: ROK_MODE_MARKER_TYPE, content: `${verb} ${action}`, display: true });
}

function appendModeState(pi: ExtensionAPI, modeKind: string | null): void {
	pi.appendEntry<ModeState>(ROK_MODE_STATE_TYPE, { modeKind });
}

function createModeContextMessage(active: ActiveMode): ContextEvent["messages"][number] {
	const message = {
		role: "custom",
		customType: ROK_MODE_CONTEXT_TYPE,
		content: active.content,
		display: false,
		timestamp: Date.now(),
	} satisfies ContextEvent["messages"][number];
	return message;
}

function isSoulModeMessageType(customType: string): boolean {
	return (
		customType === ROK_MODE_CONTEXT_TYPE ||
		customType === LEGACY_ROK_MODE_MESSAGE_TYPE ||
		customType === ROK_MODE_MARKER_TYPE
	);
}

function readModeState(value: unknown): ModeState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const modeKind = record.modeKind;
	if (modeKind !== null && typeof modeKind !== "string") return undefined;
	return { modeKind };
}
