import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPromptSource } from "../../shared/prompt-contributions.ts";
import { formatLocalDisplayDate, formatRuntimeContextMessage, freezeRuntimeContext } from "./context.ts";

export default function runtimeContextExtension(pi: ExtensionAPI): void {
	registerPromptSource(pi, {
		key: "runtime/environment",
		section: "environment",
		refresh: "compaction",
		async read(ctx) {
			const snapshot = freezeRuntimeContext(ctx.cwd);
			return formatRuntimeContextMessage(formatLocalDisplayDate(new Date()), snapshot.rootSnapshot);
		},
	});
}
