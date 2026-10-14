import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DecisionClient, DecisionResult, DecisionRoute } from "../../shared/decisions.ts";
import { emitTauEvent, onTauEvent } from "../../shared/events.ts";
import type { readUsageCosts } from "../../shared/usage.ts";
import settingsSpec, { type RouteCandidate } from "./settings.ts";

type Settings = typeof settingsSpec.defaults;

export function registerRouting(
	pi: ExtensionAPI,
	client: DecisionClient,
	getSettings: () => Settings,
	sessionSignal: () => AbortSignal,
	readUsage: typeof readUsageCosts,
): void {
	let eligible = false;
	let explicit = false;
	let selecting = false;
	let pending: { prompt: string; result: Promise<DecisionResult> } | undefined;
	function restore(ctx: ExtensionContext) {
		const branch = ctx.sessionManager.getBranch();
		eligible = !branch.some((entry) => entry.type === "message" && entry.message.role === "user");
		const latest = [...branch]
			.reverse()
			.find((entry) => entry.type === "custom" && entry.customType === "tau.decisions.route");
		explicit = latest?.type === "custom" && latest.data === null;
		pending = undefined;
	}
	function classify(prompt: string, ctx: ExtensionContext) {
		return client.classify(
			"routing",
			ctx,
			{ prompt },
			{
				route: {
					type: "choice",
					instructions:
						"Which work type does this prompt start? Judge the requested work, not possible future implementation. Prefer quick for bounded questions, investigation, changes, and planning using existing patterns. Reserve general for substantial engineering or deep investigation. Frontend implementation prefers frontend; design within an established system, including whole pages, prefers simple-design. Ordinary architecture and implementation planning belong in quick or general. Choose architecture or complex-design only with clear evidence of exceptional difficulty, unresolved constraints, or substantial invention. Words such as architecture, redesign, creative, and multi-screen do not alone justify these exceptional routes. When uncertain between ordinary and exceptional design, choose simple-design; between ordinary and exceptional architecture, choose general.",
					criteria: Object.fromEntries(
						Object.entries(getSettings().routing.routes).map(([name, route]) => [name, route.description]),
					),
				},
			},
		);
	}
	async function apply(result: DecisionResult, ctx: ExtensionContext, signal: AbortSignal) {
		if (explicit || signal.aborted || ctx.signal?.aborted || !client.enabled("routing")) return;
		// No classifier setup preserves the user's current model, like the other decision features.
		if (result.status === "disabled" || (result.status === "unavailable" && result.model === null)) return;
		const { routes, balance } = getSettings().routing;
		let name: keyof typeof routes = "general";
		let probabilities: Record<string, number> = {};
		if (result.status === "ok" && result.answers.route?.type === "choice") {
			probabilities = result.answers.route.probabilities;
			const best = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
			if (best && best[1] >= 0.5 && Object.hasOwn(routes, best[0])) name = best[0] as keyof typeof routes;
		}
		const peers = [...routes[name].candidates];
		if (new Set(peers.map((candidate) => candidate.provider)).size > 1) {
			try {
				const endMs = Date.now();
				const costs = await readUsage(
					{ startMs: endMs - balance.windowHours * 60 * 60 * 1000, endMs },
					AbortSignal.any([signal, AbortSignal.timeout(3000), ...(ctx.signal ? [ctx.signal] : [])]),
				);
				const pressure = {
					"openai-codex": costs.openai / balance.providerWeights["openai-codex"],
					anthropic: costs.anthropic / balance.providerWeights.anthropic,
				};
				peers.sort((a, b) => pressure[a.provider] - pressure[b.provider]);
			} catch {
				// Usage is approximate; unavailable accounting preserves configured preference.
			}
		}
		if (explicit || signal.aborted || ctx.signal?.aborted || !client.enabled("routing")) return;
		const fallback: RouteCandidate = {
			provider: "anthropic",
			model: name === "quick" ? "claude-haiku-5-5" : "claude-sonnet-5-5",
			thinking: "high",
		};
		const candidates =
			name === "quick"
				? [...peers, fallback, ...routes.general.candidates]
				: [...peers, ...routes.general.candidates, fallback];
		for (const route of candidates) {
			const model = ctx.modelRegistry
				.getAvailable()
				.find(
					(model) =>
						model.provider === route.provider &&
						model.id === route.model &&
						ctx.modelRegistry.isUsingOAuth(model),
				);
			if (!model) continue;
			if (signal.aborted || ctx.signal?.aborted || explicit || !client.enabled("routing")) return;
			selecting = true;
			try {
				if (!(await pi.setModel(model))) continue;
				pi.setThinkingLevel(route.thinking);
				const record: DecisionRoute = {
					route: name,
					probabilities,
					model: `${model.provider}/${model.id}`,
					thinking: pi.getThinkingLevel(),
					elapsedMs: result.elapsedMs,
					status: result.status,
				};
				pi.appendEntry("tau.decisions.route", record);
				emitTauEvent(pi, "tau:decisions.route", record);
				return;
			} catch {
				if (signal.aborted || explicit) return;
			} finally {
				selecting = false;
			}
		}
	}
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("model_select", (event) => {
		if (selecting || event.source === "restore") return;
		explicit = true;
		eligible = false;
		pending = undefined;
		pi.appendEntry("tau.decisions.route", null);
		emitTauEvent(pi, "tau:decisions.route", null);
	});
	pi.on("input", (event, ctx) => {
		pending = undefined;
		if (
			!eligible ||
			explicit ||
			event.source !== "interactive" ||
			event.streamingBehavior ||
			!ctx.isIdle() ||
			event.text.startsWith("/") ||
			!client.enabled("routing")
		)
			return;
		pending = { prompt: event.text, result: classify(event.text, ctx) };
	});
	pi.on("before_agent_start", async (event, ctx) => {
		if (!("prompt" in event)) return;
		if (!eligible || explicit || !client.enabled("routing")) return;
		eligible = false;
		const request = pending;
		pending = undefined;
		const signal = sessionSignal();
		await apply(await (request?.prompt === event.prompt ? request.result : classify(event.prompt, ctx)), ctx, signal);
	});
	onTauEvent(pi, "decisions.routing", "tau:compaction.handoff", ({ note, ctx, signal, waitFor }) => {
		if (explicit || !client.enabled("routing")) return;
		waitFor(classify(note, ctx).then((result) => apply(result, ctx, signal)));
	});
	pi.on("session_shutdown", () => {
		eligible = false;
		explicit = true;
		pending = undefined;
	});
}
