import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, type AutocompleteItem } from "@earendil-works/pi-tui";
import { emitTauEvent, onTauEvent } from "../../shared/events.ts";
import {
	effortForSelection,
	type EffortProviderCandidates,
	type ModelEffort,
	resolveEffortProviders,
} from "../../shared/model-effort.ts";
import { EFFORT_STATE_TYPE, effortState, nextEffort } from "./state.ts";

const EFFORTS: readonly ModelEffort[] = ["low", "medium", "high"];

export default function effortExtension(pi: ExtensionAPI): void {
	let activeEffort: ModelEffort | undefined;
	let applying = false;

	function publish(): void {
		emitTauEvent(pi, "tau:model-effort.changed", { effort: activeEffort });
	}

	function setEffort(effort: ModelEffort | undefined): void {
		if (activeEffort === effort) return;
		activeEffort = effort;
		pi.appendEntry(EFFORT_STATE_TYPE, effortState(effort));
		publish();
	}

	async function apply(
		ctx: ExtensionContext,
		effort: ModelEffort,
		provider: EffortProviderCandidates,
	): Promise<boolean> {
		applying = true;
		try {
			for (const candidate of provider.candidates) {
				if (!(await pi.setModel(candidate.model))) continue;
				pi.setThinkingLevel(candidate.reasoning);
				setEffort(effortForSelection(provider.provider, candidate.model.id, pi.getThinkingLevel()));
				ctx.ui.notify(`Effort: ${effort} · ${provider.label}/${candidate.model.id}`, "info");
				return true;
			}
			return false;
		} finally {
			applying = false;
		}
	}

	async function chooseProvider(ctx: ExtensionContext, effort: ModelEffort): Promise<void> {
		const providers = resolveEffortProviders(ctx, effort);
		if (providers.length === 0) {
			ctx.ui.notify(`No logged-in provider has a ${effort} effort model. Current model kept.`, "warning");
			return;
		}
		const labels = providers.map((provider) => `${provider.label} · ${provider.provider}`);
		const selected = await ctx.ui.select(`Provider for ${effort} effort`, labels);
		if (!selected) return;
		const provider = providers[labels.indexOf(selected)];
		if (!provider) return;
		if (!(await apply(ctx, effort, provider))) {
			ctx.ui.notify(`Could not select a ${effort} model from ${provider.label}. Current model kept.`, "warning");
		}
	}

	pi.registerCommand("effort", {
		description: "Select effort tier and logged-in provider",
		getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
			const value = prefix.trimStart();
			if (/\s/.test(value)) return null;
			const items = EFFORTS.filter((effort) => effort.startsWith(value)).map((effort) => ({
				value: effort,
				label: effort,
			}));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			if (!ctx.hasUI) {
				ctx.ui.notify("/effort requires interactive UI.", "error");
				return;
			}
			const arg = args.trim().toLowerCase();
			if (arg && !isModelEffort(arg)) {
				ctx.ui.notify("Usage: /effort [low|medium|high]", "error");
				return;
			}
			let effort: ModelEffort | undefined = isModelEffort(arg) ? arg : undefined;
			if (!arg) {
				const selected = await ctx.ui.select("Effort", [...EFFORTS]);
				if (selected && isModelEffort(selected)) effort = selected;
			}
			if (!effort) return;
			await chooseProvider(ctx, effort);
		},
	});

	pi.registerShortcut(Key.ctrlShift("e"), {
		description: "Cycle effort for current provider",
		handler: async (ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current run before changing effort.", "warning");
				return;
			}
			const effort = nextEffort(activeEffort);
			const provider = resolveEffortProviders(ctx, effort).find((item) => item.provider === ctx.model?.provider);
			if (!provider || !(await apply(ctx, effort, provider))) {
				ctx.ui.notify(`Current provider has no available ${effort} effort model. Current model kept.`, "warning");
			}
		},
	});

	onTauEvent(pi, "model-effort.snapshot", "tau:model-effort.snapshot.requested", publish);

	pi.on("session_start", (_event, ctx) => {
		activeEffort = effortForSelection(ctx.model?.provider, ctx.model?.id, pi.getThinkingLevel());
		publish();
	});
	pi.on("session_tree", (_event, ctx) => {
		activeEffort = effortForSelection(ctx.model?.provider, ctx.model?.id, pi.getThinkingLevel());
		publish();
	});
	pi.on("model_select", (event) => {
		if (!applying) setEffort(effortForSelection(event.model.provider, event.model.id, pi.getThinkingLevel()));
	});
	pi.on("thinking_level_select", (event, ctx) => {
		if (!applying) {
			setEffort(effortForSelection(ctx.model?.provider, ctx.model?.id, event.level));
		}
	});
}

function isModelEffort(value: string): value is ModelEffort {
	return value === "low" || value === "medium" || value === "high";
}
