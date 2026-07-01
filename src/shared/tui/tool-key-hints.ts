import { keyHint, rawKeyHint, type Theme } from "@earendil-works/pi-coding-agent";
import type { Keybinding } from "@earendil-works/pi-tui";

export type ToolKeyHint =
	| { kind: "binding"; binding: Keybinding; label: string }
	| { kind: "raw"; key: string; label: string }
	| { kind: "text"; text: string };

export function bindingHint(binding: Keybinding, label: string): ToolKeyHint {
	return { kind: "binding", binding, label };
}

export function rawHint(key: string, label: string): ToolKeyHint {
	return { kind: "raw", key, label };
}

export function textHint(text: string): ToolKeyHint {
	return { kind: "text", text };
}

export function renderToolKeyHints(theme: Theme, hints: readonly ToolKeyHint[]): string {
	const separator = theme.fg("dim", " · ");
	return hints.map(renderToolKeyHint).join(separator);
}

function renderToolKeyHint(hint: ToolKeyHint): string {
	switch (hint.kind) {
		case "binding":
			return keyHint(hint.binding, hint.label);
		case "raw":
			return rawKeyHint(hint.key, hint.label);
		case "text":
			return hint.text;
	}
}
