import type { BeforeAgentStartEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface TauSystemPromptContribution {
	id: string;
	order: number;
	render: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => string | undefined | Promise<string | undefined>;
}

interface Registration extends TauSystemPromptContribution {
	token: symbol;
}

const registrations = new Map<string, Registration>();

export function registerTauSystemPromptContribution(contribution: TauSystemPromptContribution): () => void {
	const token = Symbol(contribution.id);
	registrations.set(contribution.id, { ...contribution, token });
	return () => {
		if (registrations.get(contribution.id)?.token === token) registrations.delete(contribution.id);
	};
}

export async function collectTauSystemPromptContributions(
	event: BeforeAgentStartEvent,
	ctx: ExtensionContext,
): Promise<string[]> {
	const ordered = [...registrations.values()].sort(
		(left, right) => left.order - right.order || left.id.localeCompare(right.id),
	);
	const rendered = await Promise.all(ordered.map((contribution) => contribution.render(event, ctx)));
	const seen = new Set<string>();
	const blocks: string[] = [];
	for (const value of rendered) {
		const block = value?.trim();
		if (!block || seen.has(block)) continue;
		seen.add(block);
		blocks.push(block);
	}
	return blocks;
}
