import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ToolRowVisualState } from "./tool-row-state.js";
import type { DecisionClient, DecisionRoute, DecisionUsage } from "./decisions.ts";
import type { ScriptSourceStore } from "./script-source.ts";

export type TauAgentEvents = {
	/** @internal Runtime-scoped classifier client. */
	"tau:decisions.client": { accept(client: DecisionClient): void };
	"tau:decisions.usage": DecisionUsage;
	"tau:decisions.route": DecisionRoute | null;
	/** @internal Register routing work before the note starts the next request. */
	"tau:compaction.handoff": {
		note: string;
		ctx: ExtensionContext;
		signal: AbortSignal;
		waitFor(promise: Promise<void>): void;
	};
	"tau:compaction.level": {
		level: "normal" | "notice" | "warning" | "forced" | "compacting";
		tokens: number | null;
		thresholds: { notice: number; warning: number; forced: number } | null;
	};
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
	/** @internal Eval's live source store, used to review the code it will execute. */
	"tau:eval.source-store": {
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

export function decisionClientFrom(pi: EmitEventAPI): DecisionClient | undefined {
	const clients: DecisionClient[] = [];
	emitTauEvent(pi, "tau:decisions.client", { accept: (client) => clients.push(client) });
	return clients.length === 1 ? clients[0] : undefined;
}
