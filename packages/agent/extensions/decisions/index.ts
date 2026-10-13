import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { emitTauEvent, onTauEvent } from "../../shared/events.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { readUsageCosts } from "../../shared/usage.ts";
import { registerAnswerFirst } from "./answer-first.ts";
import { createDecisionClient, selectClassifier } from "./classifier.ts";
import { registerRouting } from "./routing.ts";
import settingsSpec from "./settings.ts";

export default function decisionsExtension(pi: ExtensionAPI): void {
	let settings = settingsSpec.defaults;
	let lifetime = new AbortController();
	const client = createDecisionClient(
		pi,
		() => settings,
		() => lifetime.signal,
	);
	onTauEvent(pi, "decisions.client", "tau:decisions.client", ({ accept }) => accept(client));
	async function refresh(ctx: ExtensionContext) {
		settings = await loadTauExtensionSettings(ctx, settingsSpec);
		try {
			const selected = await selectClassifier(
				ctx,
				settings,
				AbortSignal.any([lifetime.signal, AbortSignal.timeout(3000)]),
			);
			emitTauEvent(pi, "tau:decisions.classifier", selected ? (selected.family === "jev" ? "Jev" : "Luna") : null);
		} catch {
			emitTauEvent(pi, "tau:decisions.classifier", null);
		}
	}
	pi.on("session_start", async (_event, ctx) => {
		lifetime.abort();
		lifetime = new AbortController();
		await refresh(ctx);
	});
	pi.on("input", async (_event, ctx) => {
		await refresh(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		lifetime.abort();
		lifetime = new AbortController();
		await refresh(ctx);
	});
	registerRouting(
		pi,
		client,
		() => settings,
		() => lifetime.signal,
		readUsageCosts,
	);
	registerAnswerFirst(pi, client);
	pi.on("session_shutdown", () => {
		lifetime.abort();
		emitTauEvent(pi, "tau:decisions.classifier", null);
	});
}
