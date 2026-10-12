// Stand-in for the @shanepadgett/tau SDK embedded in the binary.
export const instanceId = crypto.randomUUID();

type Extension = { name: string; describe(): string };

export const registry: Extension[] = [];

export function defineExtension(extension: Extension): void {
	registry.push(extension);
}
