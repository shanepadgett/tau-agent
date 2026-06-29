import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { LabeledDotLine } from "../../shared/tui/labeled-dot-line.ts";
import turnBudgetSettings from "./settings.ts";

const MARKER_TYPE = "tau.turn-budget.marker";

interface Settings {
	enabled: boolean;
	turnLimit: number;
	nudgeEveryTurns: number;
	softCapIncrement: number;
}

type Hint =
	| { kind: "normal"; used: number; cap: number }
	| { kind: "extended"; used: number; previousCap: number; newCap: number };

interface MarkerDetails {
	used: number;
	cap: number;
	extended: boolean;
	sequence: number;
}

export default function turnBudgetExtension(pi: ExtensionAPI): void {
	let settings = normalizeSettings(turnBudgetSettings.defaults);
	let turnCount = 0;
	let softCap = settings.turnLimit;
	let nextMarkerSequence = 1;
	let activeMarkerSequence: number | undefined;

	pi.registerMessageRenderer<MarkerDetails>(MARKER_TYPE, (message, _options, theme) => {
		const details = readMarkerDetails(message.details);
		if (!details) return undefined;
		return new LabeledDotLine({
			theme,
			dotColor: "dim",
			label: "Turn Budget:",
			labelColor: "toolTitle",
			parts: [
				theme.fg("muted", `${details.used}/${details.cap}`),
				...(details.extended ? [theme.fg("muted", "Soft cap extended.")] : []),
			],
		});
	});

	pi.on("before_agent_start", (event) => {
		if (!settings.enabled) return undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\nTurn-budget steering messages are internal instructions. Work within them silently. Do not mention or acknowledge turn counts, budget messages, or budget summaries.`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		settings = normalizeSettings(await loadTauExtensionSettings(ctx, turnBudgetSettings));
	});

	pi.on("agent_start", () => {
		turnCount = 0;
		softCap = settings.turnLimit;
		activeMarkerSequence = undefined;
	});

	pi.on("turn_end", (event) => {
		if (!settings.enabled) return undefined;
		if (event.toolResults.length === 0) return undefined;
		turnCount += 1;
		if (turnCount >= softCap) {
			const hint: Hint = {
				kind: "extended",
				used: turnCount,
				previousCap: softCap,
				newCap: turnCount + settings.softCapIncrement,
			};
			activeMarkerSequence = nextMarkerSequence;
			sendTurnBudgetMessage(pi, hint, nextMarkerSequence);
			nextMarkerSequence += 1;
			softCap = hint.newCap;
			return undefined;
		}
		if (turnCount % settings.nudgeEveryTurns === 0) {
			const hint: Hint = { kind: "normal", used: turnCount, cap: softCap };
			activeMarkerSequence = nextMarkerSequence;
			sendTurnBudgetMessage(pi, hint, nextMarkerSequence);
			nextMarkerSequence += 1;
		}
		return undefined;
	});

	pi.on("context", (event) => {
		const messages = event.messages.filter(
			(message) =>
				message.role !== "custom" || message.customType !== MARKER_TYPE || markerIsActive(message.details),
		);
		if (messages.length === event.messages.length) return undefined;
		return { messages };
	});

	pi.on("after_provider_response", () => {
		activeMarkerSequence = undefined;
	});

	function markerIsActive(value: unknown): boolean {
		if (activeMarkerSequence === undefined) return false;
		const details = readMarkerDetails(value);
		return details?.sequence === activeMarkerSequence;
	}
}

function sendTurnBudgetMessage(pi: ExtensionAPI, hint: Hint, sequence: number): void {
	pi.sendMessage<MarkerDetails>({
		customType: MARKER_TYPE,
		content: formatSteeringMessage(hint),
		display: true,
		details: markerDetails(hint, sequence),
	});
}

function formatSteeringMessage(hint: Hint): string {
	if (hint.kind === "extended") {
		return `Turn budget: ${hint.used}/${hint.previousCap} turns used for this user prompt. Soft cap extended to ${hint.newCap}. Batch tools when more tool work remains.`;
	}
	return `Turn budget: ${hint.used}/${hint.cap} turns used for this user prompt. Batch tools when more tool work remains.`;
}

function normalizeSettings(value: typeof turnBudgetSettings.defaults): Settings {
	return {
		enabled: value.enabled ?? true,
		turnLimit: Number.isInteger(value.turnLimit) && value.turnLimit > 0 ? value.turnLimit : 30,
		nudgeEveryTurns: Number.isInteger(value.nudgeEveryTurns) && value.nudgeEveryTurns > 0 ? value.nudgeEveryTurns : 5,
		softCapIncrement:
			Number.isInteger(value.softCapIncrement) && value.softCapIncrement > 0 ? value.softCapIncrement : 10,
	};
}

function markerDetails(hint: Hint, sequence: number): MarkerDetails {
	return hint.kind === "extended"
		? { used: hint.used, cap: hint.newCap, extended: true, sequence }
		: { used: hint.used, cap: hint.cap, extended: false, sequence };
}

function readMarkerDetails(value: unknown): MarkerDetails | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const used = record.used;
	const cap = record.cap;
	const sequence = record.sequence;
	if (typeof used !== "number" || !Number.isInteger(used) || used < 0) return undefined;
	if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1) return undefined;
	if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 1) return undefined;
	if (typeof record.extended !== "boolean") return undefined;
	return { used, cap, extended: record.extended, sequence };
}
