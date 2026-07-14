import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { collectTauSystemPromptContributions } from "../../shared/system-prompt-contributions.ts";
import {
	buildRokPrompt,
	fingerprintRuntimeSnapshot,
	formatLocalDateKey,
	formatLocalDisplayDate,
	formatRuntimeContextMessage,
	freezeRuntimeContext,
	type RuntimeContext,
} from "./prompt.ts";
import soulSettings from "./settings.ts";

const RUNTIME_CONTEXT_TYPE = "tau.runtime-context";

interface RuntimeContextMessageDetails {
	version: 1;
	dateKey: string;
	snapshotHash: string;
	includesSnapshot: boolean;
}

export default function soulExtension(pi: ExtensionAPI): void {
	let enabled = true;
	let runtimeContext: RuntimeContext | undefined;

	pi.on("session_start", async (_event, ctx) => {
		enabled = (await loadTauExtensionSettings(ctx, soulSettings)).enabled;
		runtimeContext = freezeRuntimeContext(ctx.cwd);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		runtimeContext ??= freezeRuntimeContext(ctx.cwd);
		// Pi reuses base prompt options, so Tau-owned additions compose here without accumulating mutations.
		const contributions = await collectTauSystemPromptContributions(event, ctx);
		const basePrompt = enabled ? buildRokPrompt(event.systemPromptOptions, runtimeContext) : event.systemPrompt;
		const systemPrompt = [basePrompt, ...contributions].filter((block) => block.trim()).join("\n\n");

		const now = new Date();
		const dateKey = formatLocalDateKey(now);
		const snapshotHash = fingerprintRuntimeSnapshot(runtimeContext);
		let hasDate = false;
		let hasSnapshot = false;
		for (const entry of ctx.sessionManager.buildContextEntries()) {
			const details = runtimeContextDetails(entry);
			if (!details) continue;
			if (details.dateKey === dateKey) hasDate = true;
			if (details.includesSnapshot && details.snapshotHash === snapshotHash) hasSnapshot = true;
		}

		const includeSnapshot = !hasSnapshot;
		const message =
			hasDate && hasSnapshot
				? undefined
				: {
						customType: RUNTIME_CONTEXT_TYPE,
						content: formatRuntimeContextMessage(
							formatLocalDisplayDate(now),
							includeSnapshot ? runtimeContext.rootSnapshot : undefined,
						),
						display: false,
						details: {
							version: 1,
							dateKey,
							snapshotHash,
							includesSnapshot: includeSnapshot,
						} satisfies RuntimeContextMessageDetails,
					};

		if (!enabled && contributions.length === 0 && !message) return undefined;
		return {
			...(enabled || contributions.length > 0 ? { systemPrompt } : {}),
			...(message ? { message } : {}),
		};
	});
}

function runtimeContextDetails(value: unknown): RuntimeContextMessageDetails | undefined {
	if (!value || typeof value !== "object") return undefined;
	const entry = value as Record<string, unknown>;
	if (entry.type !== "custom_message" || entry.customType !== RUNTIME_CONTEXT_TYPE || entry.display !== false) {
		return undefined;
	}
	if (!entry.details || typeof entry.details !== "object") return undefined;
	const details = entry.details as Record<string, unknown>;
	if (
		details.version !== 1 ||
		typeof details.dateKey !== "string" ||
		typeof details.snapshotHash !== "string" ||
		typeof details.includesSnapshot !== "boolean"
	) {
		return undefined;
	}
	return {
		version: 1,
		dateKey: details.dateKey,
		snapshotHash: details.snapshotHash,
		includesSnapshot: details.includesSnapshot,
	};
}
