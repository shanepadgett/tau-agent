import type { ContextEvent } from "@earendil-works/pi-coding-agent";

type ContextMessage = ContextEvent["messages"][number];

export const CONTEXT_PROJECTION_TYPE = "tau.context.projection";

export function isContextProjectionMessage(message: ContextMessage): boolean {
	return message.role === "custom" && message.customType === CONTEXT_PROJECTION_TYPE;
}

export function isLegacyContextMessage(message: ContextMessage): boolean {
	if (message.role !== "custom") return false;
	if (message.customType !== "tau.injected-context" && message.customType !== "tau.autoread") return false;
	return (
		message.details !== undefined &&
		typeof message.details === "object" &&
		(message.details as Record<string, unknown>).source === "context"
	);
}
