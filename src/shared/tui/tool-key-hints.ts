import { keyHint, rawKeyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Keybinding } from "@earendil-works/pi-tui";

export type ToolKeyHint =
	| { kind: "binding"; binding: Keybinding; label: string }
	| { kind: "bindings"; bindings: readonly Keybinding[]; label: string }
	| { kind: "raw"; key: string; label: string };

export function bindingHint(binding: Keybinding, label: string): ToolKeyHint {
	return { kind: "binding", binding, label };
}

export function bindingsHint(bindings: readonly Keybinding[], label: string): ToolKeyHint {
	return { kind: "bindings", bindings, label };
}

export function rawHint(key: string, label: string): ToolKeyHint {
	return { kind: "raw", key, label };
}

export function renderToolKeyHints(theme: Theme, hints: readonly ToolKeyHint[]): string {
	const separator = theme.fg("dim", " · ");
	return hints.map(renderToolKeyHint).join(separator);
}

function renderToolKeyHint(hint: ToolKeyHint): string {
	switch (hint.kind) {
		case "binding":
			return keyHint(hint.binding, hint.label);
		case "bindings":
			return rawKeyHint(formatBindingGroup(hint.bindings), hint.label);
		case "raw":
			return rawKeyHint(hint.key, hint.label);
	}
}

function formatBindingGroup(bindings: readonly Keybinding[]): string {
	const keys = bindings
		.map((binding) => getKeybindings().getKeys(binding)[0])
		.filter((key) => key !== undefined)
		.map(formatGroupedKey);
	return compactRawKeys(keys);
}

function formatGroupedKey(key: string): string {
	return key
		.replace(/\bpageUp\b/g, "pgup")
		.replace(/\bpageDown\b/g, "pgdn")
		.replace(/\bup\b/g, "↑")
		.replace(/\bdown\b/g, "↓")
		.replace(/\bleft\b/g, "←")
		.replace(/\bright\b/g, "→");
}

function compactRawKeys(keys: readonly string[]): string {
	if (keys.length === 1) return keys[0] ?? "";

	const parts = keys.map((key) => {
		const separatorIndex = key.lastIndexOf("+");
		return separatorIndex === -1
			? { prefix: "", suffix: key }
			: { prefix: key.slice(0, separatorIndex + 1), suffix: key.slice(separatorIndex + 1) };
	});
	const prefix = parts[0]?.prefix ?? "";
	return prefix && parts.every((part) => part.prefix === prefix)
		? `${prefix}${parts.map((part) => part.suffix).join("/")}`
		: keys.join("/");
}
