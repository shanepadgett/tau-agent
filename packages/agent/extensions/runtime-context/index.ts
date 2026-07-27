import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	formatLocalDisplayDate,
	formatRuntimeContextMessage,
	freezeRuntimeContext,
	type RuntimeContext,
} from "./context.ts";

export default function runtimeContextExtension(pi: ExtensionAPI): void {
	let runtimeContext: RuntimeContext | undefined;

	pi.on("session_start", (_event, ctx) => {
		runtimeContext = freezeRuntimeContext(ctx.cwd);
	});

	pi.on("before_agent_start", (event, ctx) => {
		runtimeContext ??= freezeRuntimeContext(ctx.cwd);
		const content = formatRuntimeContextMessage(formatLocalDisplayDate(new Date()), runtimeContext.rootSnapshot);
		return { systemPrompt: `${event.systemPrompt}\n\n${content}` };
	});
}
