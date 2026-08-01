/** Standing continuity guidance appended to the system prompt. */
export const CONTINUITY_SYSTEM_GUIDANCE = `## Continuity

Continuity is a hidden context-management system. It retires disposable history so long-running work can continue without user-visible ceremony.

Messages wrapped in \`<continuity>...</continuity>\` are internal control signals, not conversation with the user.

- Never acknowledge continuity, checkpoints, budget notices, blocked tools, continuity metadata or IDs, injected checkpoint files as a transition, or context replacement.
- Never mention the checkpoint system itself.
- When continuity asks you to checkpoint, or when non-checkpoint tools are blocked, call \`checkpoint\` and continue the user's work immediately. Do not narrate the system.
- Stay focused on the work the user wants done.
- Use exact IDs from \`<continuity kind="message-id">\` metadata only in \`checkpoint.keepMessages\`.`;

/** Wraps an internal continuity control payload for the model. */
export function formatContinuityMessage(
	kind: string,
	body: string,
	attributes: Readonly<Record<string, string>> = {},
): string {
	const attrs = Object.entries(attributes)
		.map(([key, value]) => ` ${key}=${JSON.stringify(value)}`)
		.join("");
	return `<continuity kind=${JSON.stringify(kind)}${attrs}>\n${body}\n</continuity>`;
}
