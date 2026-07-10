import {
	initTheme,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import branchExtension, { normalizeBranchName } from "../../../src/extensions/branch/index.ts";
import type { BranchChoice } from "../../../src/extensions/branch/panel.ts";

type BranchHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type PanelDone = (choice: BranchChoice | undefined) => void;
type PanelAction = (component: Component, done: PanelDone) => void | Promise<void>;
type PanelFactory = (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: PanelDone) => Component;

const LIST_REFS_COMMAND =
	"for-each-ref --sort=-committerdate --format=%(refname)%00%(committerdate:unix)%00%(HEAD)%00%(symref) refs/heads refs/remotes";

beforeAll(() => initTheme());

interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
	killed: boolean;
}

function execResult(stdout: string, code = 0, stderr = ""): ExecResult {
	return { code, stdout, stderr, killed: false };
}

function localChoice(name: string, updatedAt: number): BranchChoice {
	return { id: `local:${name}`, kind: "local", label: name, name, updatedAt };
}

function remoteChoice(upstream: string, name: string, updatedAt: number): BranchChoice {
	return { id: `remote:${upstream}`, kind: "remote", label: upstream, name, upstream, updatedAt };
}

function createCommandHarness(
	responses: ReadonlyMap<string, ExecResult>,
	selections: Array<string | undefined>,
	inputs: Array<string | undefined>,
	panelActions: PanelAction[],
) {
	const registered: { handler: BranchHandler | undefined } = { handler: undefined };
	const exec = vi.fn(async (_command: string, args: string[]) => {
		const key = args.join(" ");
		return responses.get(key) ?? execResult("", 127, `Unexpected git command: ${key}`);
	});
	const pi = {
		exec,
		registerCommand: (_name: string, command: { handler: BranchHandler }) => {
			registered.handler = command.handler;
		},
	} as unknown as ExtensionAPI;
	branchExtension(pi);
	const handler = registered.handler;
	if (!handler) throw new Error("Branch command was not registered.");

	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
	const tui = { requestRender: vi.fn() } as unknown as TUI;
	const keybindings = {} as unknown as KeybindingsManager;
	const custom = vi.fn(
		(factory: PanelFactory) =>
			new Promise<BranchChoice | undefined>((resolve, reject) => {
				const action = panelActions.shift();
				if (!action) {
					reject(new Error("Unexpected branch panel."));
					return;
				}
				const component = factory(tui, theme, keybindings, resolve);
				void Promise.resolve(action(component, resolve)).catch(reject);
			}),
	);
	const select = vi.fn(async () => selections.shift());
	const input = vi.fn(async () => inputs.shift());
	const notify = vi.fn();
	const ctx = {
		cwd: "/repo",
		hasUI: true,
		mode: "tui",
		signal: undefined,
		waitForIdle: vi.fn(async () => undefined),
		ui: { custom, select, input, notify },
	} as unknown as ExtensionCommandContext;

	return { handler, ctx, exec, custom, select, input, notify };
}

describe("branch name normalization", () => {
	it("keeps lowercase hyphenated names", () => {
		expect(normalizeBranchName("add-branch-command")).toBe("add-branch-command");
	});

	it("lowercases and cleans sentences", () => {
		expect(normalizeBranchName("Fix login. Please")).toBe("fix-login-please");
	});

	it("collapses repeated punctuation and whitespace", () => {
		expect(normalizeBranchName("fix...   login___please")).toBe("fix-login-please");
	});

	it("trims surrounding separators", () => {
		expect(normalizeBranchName(" -- Add login! -- ")).toBe("add-login");
	});

	it("returns empty for input without letters or numbers", () => {
		expect(normalizeBranchName(" ... --- ")).toBe("");
	});
});

describe("branch command", () => {
	it("opens cached recent branches without fetching", async () => {
		const refs = [
			"refs/heads/local-old\u0000100\u0000 \u0000",
			"refs/remotes/origin/main\u0000400\u0000 \u0000",
			"refs/heads/local-recent\u0000500\u0000 \u0000",
			"refs/remotes/origin/topic\u0000300\u0000 \u0000",
			"refs/heads/main\u0000200\u0000*\u0000",
			"refs/remotes/origin/HEAD\u0000600\u0000 \u0000refs/remotes/origin/main",
		].join("\n");
		let rendered = "";
		const harness = createCommandHarness(
			new Map([
				["rev-parse --show-toplevel", execResult("/repo")],
				[LIST_REFS_COMMAND, execResult(refs)],
				["switch local-recent", execResult("")],
			]),
			[],
			[],
			[
				(component, done) => {
					rendered = component.render(80).join("\n");
					done(localChoice("local-recent", 500_000));
				},
			],
		);

		await harness.handler("", harness.ctx);

		expect(harness.exec.mock.calls.map((call) => call[1])).toEqual([
			["rev-parse", "--show-toplevel"],
			[
				"for-each-ref",
				"--sort=-committerdate",
				"--format=%(refname)%00%(committerdate:unix)%00%(HEAD)%00%(symref)",
				"refs/heads",
				"refs/remotes",
			],
			["switch", "local-recent"],
		]);
		expect(rendered.indexOf("local-recent")).toBeLessThan(rendered.indexOf("origin/topic"));
		expect(rendered.indexOf("origin/topic")).toBeLessThan(rendered.indexOf("local-old"));
		expect(rendered).not.toContain("origin/main");
		expect(harness.notify).toHaveBeenLastCalledWith("Switched to local-recent.", "info");
	});

	it("fetches only after the panel requests it", async () => {
		const refs = "refs/heads/main\u0000200\u0000*\u0000\nrefs/heads/topic\u0000300\u0000 \u0000";
		const harness = createCommandHarness(
			new Map([
				["rev-parse --show-toplevel", execResult("/repo")],
				[LIST_REFS_COMMAND, execResult(refs)],
				["fetch --all", execResult("")],
			]),
			[],
			[],
			[
				async (component, _done) => {
					component.handleInput?.("\x06");
					await Promise.resolve();
					await Promise.resolve();
					await Promise.resolve();
					component.handleInput?.("\x1b");
				},
			],
		);

		await harness.handler("", harness.ctx);

		expect(harness.exec.mock.calls.map((call) => call[1])).toEqual([
			["rev-parse", "--show-toplevel"],
			expect.arrayContaining(["for-each-ref"]),
			["fetch", "--all"],
			expect.arrayContaining(["for-each-ref"]),
		]);
	});

	it("creates a tracking branch for a remote choice", async () => {
		const harness = createCommandHarness(
			new Map([
				["rev-parse --show-toplevel", execResult("/repo")],
				[
					LIST_REFS_COMMAND,
					execResult("refs/heads/main\u0000200\u0000*\u0000\nrefs/remotes/upstream/topic\u0000300\u0000 \u0000"),
				],
				["switch --track -c topic upstream/topic", execResult("")],
			]),
			[],
			[],
			[(_component, done) => done(remoteChoice("upstream/topic", "topic", 300_000))],
		);

		await harness.handler("", harness.ctx);

		expect(harness.exec).toHaveBeenLastCalledWith(
			"git",
			["switch", "--track", "-c", "topic", "upstream/topic"],
			expect.objectContaining({ cwd: "/repo" }),
		);
		expect(harness.notify).toHaveBeenLastCalledWith("Switched to topic.", "info");
	});

	it("does nothing when branch selection is cancelled", async () => {
		const harness = createCommandHarness(
			new Map([
				["rev-parse --show-toplevel", execResult("/repo")],
				[LIST_REFS_COMMAND, execResult("")],
			]),
			[],
			[],
			[(_component, done) => done(undefined)],
		);

		await harness.handler("", harness.ctx);

		expect(harness.exec).toHaveBeenCalledTimes(2);
		expect(harness.notify).not.toHaveBeenCalled();
	});

	it("keeps branch creation under the new argument", async () => {
		const harness = createCommandHarness(
			new Map([
				["rev-parse --show-toplevel", execResult("/repo")],
				["switch -c fix/fix-login", execResult("")],
			]),
			["fix"],
			["Fix login"],
			[],
		);

		await harness.handler("new", harness.ctx);

		expect(harness.custom).not.toHaveBeenCalled();
		expect(harness.exec).toHaveBeenLastCalledWith(
			"git",
			["switch", "-c", "fix/fix-login"],
			expect.objectContaining({ cwd: "/repo" }),
		);
		expect(harness.notify).toHaveBeenLastCalledWith("Created and switched to fix/fix-login.", "info");
	});

	it("rejects unknown arguments without running Git", async () => {
		const harness = createCommandHarness(new Map<string, ExecResult>(), [], [], []);

		await harness.handler("other", harness.ctx);

		expect(harness.exec).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith("Usage: /branch or /branch new", "error");
	});

	it("rejects the custom picker outside TUI mode", async () => {
		const harness = createCommandHarness(new Map<string, ExecResult>(), [], [], []);
		const ctx = { ...harness.ctx, mode: "rpc" as const };

		await harness.handler("", ctx);

		expect(harness.exec).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith("Branch switching requires interactive TUI.", "error");
	});
});
