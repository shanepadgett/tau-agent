import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TARGET_MODELS = new Set(["fireworks/accounts/fireworks/models/glm-5p2", "zai/glm-5.2", "zai-coding-cn/glm-5.2"]);
const REQUIRED_LEVEL = "xhigh";

export default function glmXhigh(pi: ExtensionAPI): void {
	let suppressedModel: string | undefined;
	let settingModel: string | undefined;

	function modelKey(ctx: ExtensionContext): string | undefined {
		const model = ctx.model;
		return model ? `${model.provider}/${model.id}` : undefined;
	}

	function enforce(ctx: ExtensionContext): void {
		const key = modelKey(ctx);
		if (!key || !TARGET_MODELS.has(key)) return;
		if (suppressedModel === key || settingModel === key || pi.getThinkingLevel() === REQUIRED_LEVEL) return;

		settingModel = key;
		try {
			pi.setThinkingLevel(REQUIRED_LEVEL);
		} finally {
			settingModel = undefined;
		}

		if (pi.getThinkingLevel() === REQUIRED_LEVEL) return;

		suppressedModel = key;
		if (ctx.hasUI) {
			ctx.ui.notify(
				`GLM xhigh requested for ${key}, but Pi clamped it to ${pi.getThinkingLevel()}. Not retrying.`,
				"warning",
			);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		suppressedModel = undefined;
		enforce(ctx);
	});

	pi.on("model_select", (event, ctx) => {
		const previous = event.previousModel ? `${event.previousModel.provider}/${event.previousModel.id}` : undefined;
		const next = `${event.model.provider}/${event.model.id}`;
		if (previous !== next) suppressedModel = undefined;
		enforce(ctx);
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		enforce(ctx);
	});
}
