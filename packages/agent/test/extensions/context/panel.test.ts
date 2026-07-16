import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ContextEntry } from "../../../extensions/context/definitions.ts";
import { ContextPanel } from "../../../extensions/context/panel.ts";

beforeAll(() => initTheme());

function entry(files: string[], anchors: string[]): ContextEntry {
	return {
		id: "code/source/all",
		tab: "code",
		concept: "source",
		conceptName: "Source",
		conceptDescription: "Source files",
		name: "all",
		description: "All source files",
		files,
		anchors,
		path: ".pi/contexts/code/source.toml",
	};
}

function panel(value: ContextEntry): ContextPanel {
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
	const tui = {
		terminal: { columns: 100, rows: 40 },
		requestRender: vi.fn(),
	} as unknown as TUI;
	return new ContextPanel(tui, theme, [value], () => {});
}

describe("context panel", () => {
	it("labels eager and anchor paths", () => {
		const output = panel(entry(["src/runtime.ts"], ["src/fetch.ts"]))
			.render(100)
			.join("\n");
		expect(output).toContain("0 selected · 1 read · 1 anchors");
		expect(output).toContain("read • src/runtime.ts");
		expect(output).toContain("anchor • src/fetch.ts");
	});

	it("renders an anchor-only entry", () => {
		const output = panel(entry([], ["src/fetch.ts"]))
			.render(100)
			.join("\n");
		expect(output).toContain("0 selected · 0 read · 1 anchors");
		expect(output).toContain("anchor • src/fetch.ts");
	});
});
