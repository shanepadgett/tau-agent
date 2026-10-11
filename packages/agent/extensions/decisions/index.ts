import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { onTauEvent } from "../../shared/events.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
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
			const model = await selectClassifier(
				ctx,
				settings,
				AbortSignal.any([lifetime.signal, AbortSignal.timeout(3000)]),
			);
			ctx.ui.setStatus(
				"decisions",
				!settings.enabled
					? "decisions off"
					: model
						? `${model.provider}/${model.id}`
						: "decisions unavailable, no Jev or Luna credentials",
			);
		} catch {
			ctx.ui.setStatus("decisions", "decisions unavailable");
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
	);
	registerAnswerFirst(pi, client);
	pi.on("session_shutdown", (_event, ctx) => {
		lifetime.abort();
		ctx.ui.setStatus("decisions", undefined);
	});
}
