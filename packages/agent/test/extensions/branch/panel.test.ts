import { initTheme, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { type BranchChoice, showBranchPanel } from "../../../extensions/branch/panel.ts";

type PanelDone = (choice: BranchChoice | undefined) => void;
type PanelFactory = (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: PanelDone) => Component;

beforeAll(() => initTheme());

function localChoice(index: number): BranchChoice {
	const name = `branch-${index}`;
	return { id: `local:${name}`, kind: "local", label: name, name, updatedAt: index };
}

function deferred<T>() {
	const callbacks: { resolve: ((value: T) => void) | undefined } = { resolve: undefined };
	const promise = new Promise<T>((resolve) => {
		callbacks.resolve = resolve;
	});
	return {
		promise,
		resolve(value: T) {
			const resolve = callbacks.resolve;
			if (!resolve) throw new Error("Deferred promise has no resolve callback.");
			resolve(value);
		},
	};
}

function openPanel(initial: readonly BranchChoice[], refresh: () => Promise<readonly BranchChoice[]>) {
	const holder: { component: Component | undefined; done: PanelDone | undefined } = {
		component: undefined,
		done: undefined,
	};
	const result = deferred<BranchChoice | undefined>();
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
	const requestRender = vi.fn();
	const tui = { requestRender } as unknown as TUI;
	const keybindings = {} as unknown as KeybindingsManager;
	const custom = vi.fn((factory: PanelFactory) => {
		holder.done = result.resolve;
		holder.component = factory(tui, theme, keybindings, result.resolve);
		return result.promise;
	});
	const notify = vi.fn();
	const ctx = { ui: { custom, notify } } as unknown as ExtensionCommandContext;
	const resultPromise = showBranchPanel(ctx, initial, refresh);
	const component = holder.component;
	const done = holder.done;
	if (!component || !done) throw new Error("Branch panel did not open.");
	return { component, done, notify, requestRender, resultPromise };
}

async function flushAsync(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("branch panel", () => {
	it("renders at most ten branch rows", async () => {
		const panel = openPanel(
			Array.from({ length: 12 }, (_, index) => localChoice(index)),
			async () => [],
		);

		const output = panel.component.render(80).join("\n");

		expect(output.match(/branch-\d+/g)).toHaveLength(10);
		expect(output).toContain("branch-9");
		expect(output).not.toContain("branch-10");
		panel.done(undefined);
		await expect(panel.resultPromise).resolves.toBeUndefined();
	});

	it("shows fetch progress, suppresses repeats, and refreshes in place", async () => {
		const next = deferred<readonly BranchChoice[]>();
		const refresh = vi.fn(() => next.promise);
		const panel = openPanel([localChoice(1)], refresh);

		panel.component.handleInput?.("\x06");
		panel.component.handleInput?.("\x06");

		expect(refresh).toHaveBeenCalledTimes(1);
		expect(panel.component.render(80).join("\n")).toContain("Fetching branches…");

		next.resolve([localChoice(2)]);
		await flushAsync();

		const output = panel.component.render(80).join("\n");
		expect(output).toContain("branch-2");
		expect(output).not.toContain("branch-1");
		expect(output).not.toContain("Fetching branches…");
		panel.done(undefined);
		await expect(panel.resultPromise).resolves.toBeUndefined();
	});

	it("keeps existing branches when fetch fails", async () => {
		const refresh = vi.fn(async (): Promise<readonly BranchChoice[]> => {
			throw new Error("network unavailable");
		});
		const panel = openPanel([localChoice(1)], refresh);

		panel.component.handleInput?.("\x06");
		await flushAsync();

		const output = panel.component.render(80).join("\n");
		expect(output).toContain("branch-1");
		expect(output).not.toContain("Fetching branches…");
		expect(panel.notify).toHaveBeenCalledWith("Branch fetch failed: network unavailable", "error");
		panel.done(undefined);
		await expect(panel.resultPromise).resolves.toBeUndefined();
	});

	it("does not rerender a panel closed during fetch", async () => {
		const next = deferred<readonly BranchChoice[]>();
		const panel = openPanel([localChoice(1)], () => next.promise);

		panel.component.handleInput?.("\x06");
		panel.component.handleInput?.("\x1b");
		await expect(panel.resultPromise).resolves.toBeUndefined();
		const rendersAfterClose = panel.requestRender.mock.calls.length;

		next.resolve([localChoice(2)]);
		await flushAsync();

		expect(panel.requestRender).toHaveBeenCalledTimes(rendersAfterClose);
		expect(panel.notify).not.toHaveBeenCalled();
	});
});
