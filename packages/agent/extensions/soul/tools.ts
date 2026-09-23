import { declarationsEqual, type Api, type Model, type Tool } from "@earendil-works/pi-ai";

/** Removals only disable execution; changed declarations wait for compaction. */
export function toolChangeReason(
	model: Model<Api>,
	previous: readonly Tool[],
	requested: readonly Tool[],
): string | null {
	const existing = new Map(previous.map((tool) => [tool.name, tool]));
	for (const tool of requested) {
		const old = existing.get(tool.name);
		if (old && !declarationsEqual(old, tool))
			return `Tool ${tool.name} changed its schema or description. Compact before loading it.`;
	}
	if (requested.every((tool) => existing.has(tool.name))) return null;
	const compat = model.compat;
	const supported =
		compat &&
		"supportsMidConvoSystemMessages" in compat &&
		compat.supportsMidConvoSystemMessages === true &&
		((model.api === "anthropic-messages" &&
			"supportsMidConvoToolChanges" in compat &&
			compat.supportsMidConvoToolChanges === true &&
			previous.length > 0) ||
			((model.api === "openai-responses" || model.api === "openai-codex-responses") &&
				(("supportsAdditionalTools" in compat && compat.supportsAdditionalTools === true) ||
					("supportsToolSearch" in compat && compat.supportsToolSearch === true))));
	return supported
		? null
		: "This model cannot add tools without changing the cached prefix. Compact before loading them.";
}
