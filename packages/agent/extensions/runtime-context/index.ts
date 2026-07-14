import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	fingerprintRuntimeSnapshot,
	formatLocalDateKey,
	formatLocalDisplayDate,
	formatRuntimeContextMessage,
	freezeRuntimeContext,
	type RuntimeContext,
} from "./context.ts";

const RUNTIME_CONTEXT_TYPE = "tau.runtime-context";

interface RuntimeContextMessageDetails {
	version: 1;
	dateKey: string;
	snapshotHash: string;
	includesSnapshot: boolean;
}

export default function runtimeContextExtension(pi: ExtensionAPI): void {
	let runtimeContext: RuntimeContext | undefined;

	pi.on("session_start", (_event, ctx) => {
		runtimeContext = freezeRuntimeContext(ctx.cwd);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		runtimeContext ??= freezeRuntimeContext(ctx.cwd);
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

		if (hasDate && hasSnapshot) return undefined;
		const includeSnapshot = !hasSnapshot;
		return {
			message: {
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
			},
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
