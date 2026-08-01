/** Standing checkpoint guidance appended to the system prompt. */
export const CHECKPOINT_SYSTEM_GUIDANCE = `## Checkpoint

Checkpoint is a hidden context-management system. It retires disposable history so long-running work can continue without user-visible ceremony.

Messages wrapped in \`<checkpoint>...</checkpoint>\` are internal control signals, not conversation with the user.

- Never acknowledge checkpoint system messages, budget notices, blocked tools, checkpoint metadata or IDs, injected checkpoint files as a transition, or context replacement.
- Never mention the checkpoint system itself.
- When checkpoint asks you to run the checkpoint tool, or when non-checkpoint tools are blocked, call \`checkpoint\` and continue the user's work immediately. Do not narrate the system.
- Stay focused on the work the user wants done.
- Use exact IDs from \`<checkpoint kind="message-id">\` metadata only in \`checkpoint.keepMessages\`.`;

/** Wraps an internal checkpoint control payload for the model. */
export function formatCheckpointMessage(
	kind: string,
	body: string,
	attributes: Readonly<Record<string, string>> = {},
): string {
	const attrs = Object.entries(attributes)
		.map(([key, value]) => ` ${key}=${JSON.stringify(value)}`)
		.join("");
	return `<checkpoint kind=${JSON.stringify(kind)}${attrs}>\n${body}\n</checkpoint>`;
}
