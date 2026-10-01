import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ToolRowVisualState } from "./tool-row-state.js";
import type { ScriptSourceStore } from "./script-source.ts";
import type { FileInjectionRequest, PreparedFileInjection } from "../src/file-injection/index.ts";

export type TauAgentEvents = {
	/** @internal Soul's runtime-scoped prompt contributors. Each source becomes one named Pi prompt section. */
	"tau:prompt.sources": {
		accept(source: {
			key: string;
			section: string;
			refresh: "compaction" | "append";
			read(ctx: ExtensionContext): Promise<string>;
		}): void;
	};
	/** @internal Soul's complete instructions for the current turn, for prompt viewers. */
	"tau:prompt.snapshot": { text: string };
	"tau:agent.blocked": {
		title?: string;
		body?: string;
		source?: string;
	};
	"tau:file-mutation.applied": {
		source: "patch";
		toolCallId: string;
		cwd: string;
		status: "completed" | "partial" | "failed";
		changes: Array<{
			path: string;
			kind: "add" | "replace" | "update" | "delete";
			move?: { from: string; to: string };
			linesAdded: number;
			linesRemoved: number;
			resultingFingerprint: string | null;
			snapshotRanges?: Array<{ startLine: number; endLine: number }>;
		}>;
	};
	/** @internal Runtime-scoped request for Explore-owned file preparation. */
	"tau:file-injection.prepare": {
		request: FileInjectionRequest;
		accept(preparation: Promise<PreparedFileInjection[]>): void;
	};
	/** @internal Script runner's live source store, used to review the code it will execute. */
	"tau:script-runner.source-store": {
		accept(store: ScriptSourceStore): void;
	};
	"tau:footer-item": {
		id: string;
		text?: string;
		priority?: number;
	};
	"tau:tool-row-state.set": {
		rowId: string;
		state?: ToolRowVisualState;
	};
	/** @internal Complete-state replay for Tau-owned tool-row renderers. */
	"tau:tool-row-state.snapshot.requested": {
		requester: string;
	};
	/** @internal Complete-state replay for Tau-owned tool-row renderers. */
	"tau:tool-row-state.snapshot": {
		states: ReadonlyArray<{
			rowId: string;
			state: ToolRowVisualState;
		}>;
	};
};

export interface TauFooterItem {
	id: string;
	text?: string;
	priority?: number;
}

type EmitEventAPI = Pick<ExtensionAPI, "events">;

interface TauEventAPI extends EmitEventAPI {
	on(event: "session_start", handler: () => void): void;
	on(event: "session_shutdown", handler: () => void): void;
}

type TauEventHandler<Name extends keyof TauAgentEvents> = (data: TauAgentEvents[Name]) => void | Promise<void>;

// `pi.events` is a fresh wrapper per extension, so subscriptions are matched through the shared bus itself.
// Each copy of this module (global and project installs) announces its subscription and stops any older one.
const CLAIM_CHANNEL = "tau:subscription.claim";

interface TauSubscriptionClaim {
	owner: string;
	name: string;
}

export function emitTauEvent<Name extends keyof TauAgentEvents>(
	pi: EmitEventAPI,
	name: Name,
	data: TauAgentEvents[Name],
): void {
	pi.events.emit(name, data);
}

export function onTauEvent<Name extends keyof TauAgentEvents>(
	pi: TauEventAPI,
	owner: string,
	name: Name,
	handler: TauEventHandler<Name>,
): () => void {
	return subscribeToTauEvent(pi, owner, name, handler, false);
}

export function onTauEventImmediately<Name extends keyof TauAgentEvents>(
	pi: TauEventAPI,
	owner: string,
	name: Name,
	handler: TauEventHandler<Name>,
): () => void {
	return subscribeToTauEvent(pi, owner, name, handler, true);
}

function subscribeToTauEvent<Name extends keyof TauAgentEvents>(
	pi: TauEventAPI,
	owner: string,
	name: Name,
	handler: TauEventHandler<Name>,
	attachImmediately: boolean,
): () => void {
	if (owner.length === 0) throw new Error("Tau event owner is required.");

	let unsubscribe: (() => void) | undefined;
	let disposed = false;
	const claim: TauSubscriptionClaim = { owner, name };

	function detach(): void {
		unsubscribe?.();
		unsubscribe = undefined;
	}

	function stop(): void {
		if (disposed) return;
		disposed = true;
		detach();
		stopClaimListener();
	}

	function attach(): void {
		if (disposed) return;
		detach();
		unsubscribe = pi.events.on(name, handler as (data: unknown) => void);
	}

	pi.events.emit(CLAIM_CHANNEL, claim);
	const stopClaimListener = pi.events.on(CLAIM_CHANNEL, (other) => {
		const { owner: otherOwner, name: otherName } = other as TauSubscriptionClaim;
		if (other !== claim && otherOwner === owner && otherName === name) stop();
	});
	if (attachImmediately) attach();
	pi.on("session_start", attach);
	pi.on("session_shutdown", detach);
	return stop;
}

export function setTauFooterItem(pi: EmitEventAPI, item: TauFooterItem): void {
	emitTauEvent(pi, "tau:footer-item", item);
}
