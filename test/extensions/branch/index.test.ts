import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import branchExtension, { normalizeBranchName } from "../../../src/extensions/branch/index.ts";

type BranchHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

const LIST_REFS_COMMAND =
	"for-each-ref --sort=-committerdate --format=%(refname)%00%(committerdate:unix)%00%(HEAD)%00%(symref) refs/heads refs/remotes";

interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
	killed: boolean;
}

function execResult(stdout: string, code = 0, stderr = ""): ExecResult {
	return { code, stdout, stderr, killed: false };
}

function createCommandHarness(
	responses: ReadonlyMap<string, ExecResult>,
	selections: Array<string | undefined>,
	inputs: Array<string | undefined>,
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

	const select = vi.fn(async () => selections.shift());
	const input = vi.fn(async () => inputs.shift());
	const notify = vi.fn();
	const ctx = {
		cwd: "/repo",
		hasUI: true,
		signal: undefined,
		waitForIdle: vi.fn(async () => undefined),
		ui: { select, input, notify },
	} as unknown as ExtensionCommandContext;

	return { handler, ctx, exec, select, input, notify };
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
	it("fetches before listing recent switchable branches", async () => {
		const refs = [
			"refs/heads/local-old\u0000100\u0000 \u0000",
			"refs/remotes/origin/main\u0000400\u0000 \u0000",
			"refs/heads/local-recent\u0000500\u0000 \u0000",
			"refs/remotes/origin/topic\u0000300\u0000 \u0000",
			"refs/heads/main\u0000200\u0000*\u0000",
			"refs/remotes/origin/HEAD\u0000600\u0000 \u0000refs/remotes/origin/main",
		].join("\n");
		const harness = createCommandHarness(
			new Map([
				["rev-parse --show-toplevel", execResult("/repo")],
				["fetch --all", execResult("")],
				[LIST_REFS_COMMAND, execResult(refs)],
				["switch local-old", execResult("")],
			]),
			["local-old"],
			[],
		);

		await harness.handler("", harness.ctx);

		expect(harness.exec.mock.calls[1]?.[1]).toEqual(["fetch", "--all"]);
		expect(harness.exec.mock.calls[2]?.[1]?.[0]).toBe("for-each-ref");
		expect(harness.select).toHaveBeenCalledWith("Switch branch", ["local-recent", "origin/topic", "local-old"]);
		expect(harness.exec).toHaveBeenLastCalledWith(
			"git",
			["switch", "local-old"],
			expect.objectContaining({ cwd: "/repo" }),
		);
		expect(harness.notify).toHaveBeenLastCalledWith("Switched to local-old.", "info");
	});

	it("creates a tracking branch for a remote choice", async () => {
		const harness = createCommandHarness(
			new Map([
				["rev-parse --show-toplevel", execResult("/repo")],
				["fetch --all", execResult("")],
				[
					LIST_REFS_COMMAND,
					execResult("refs/heads/main\u0000200\u0000*\u0000\nrefs/remotes/upstream/topic\u0000300\u0000 \u0000"),
				],
				["switch --track -c topic upstream/topic", execResult("")],
			]),
			["upstream/topic"],
			[],
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
				["fetch --all", execResult("")],
				[
					LIST_REFS_COMMAND,
					execResult("refs/heads/main\u0000200\u0000*\u0000\nrefs/heads/topic\u0000300\u0000 \u0000"),
				],
			]),
			[undefined],
			[],
		);

		await harness.handler("", harness.ctx);

		expect(harness.exec).toHaveBeenCalledTimes(3);
		expect(harness.notify).not.toHaveBeenCalled();
	});

	it("aborts the picker when fetch fails", async () => {
		const harness = createCommandHarness(
			new Map([
				["rev-parse --show-toplevel", execResult("/repo")],
				["fetch --all", execResult("", 1, "network unavailable")],
			]),
			[],
			[],
		);

		await harness.handler("", harness.ctx);

		expect(harness.exec).toHaveBeenCalledTimes(2);
		expect(harness.select).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith("Branch switch failed: network unavailable", "error");
	});

	it("keeps branch creation under the new argument", async () => {
		const harness = createCommandHarness(
			new Map([
				["rev-parse --show-toplevel", execResult("/repo")],
				["switch -c fix/fix-login", execResult("")],
			]),
			["fix"],
			["Fix login"],
		);

		await harness.handler("new", harness.ctx);

		expect(harness.exec).toHaveBeenCalledTimes(2);
		expect(harness.exec).toHaveBeenLastCalledWith(
			"git",
			["switch", "-c", "fix/fix-login"],
			expect.objectContaining({ cwd: "/repo" }),
		);
		expect(harness.notify).toHaveBeenLastCalledWith("Created and switched to fix/fix-login.", "info");
	});

	it("rejects unknown arguments without running Git", async () => {
		const harness = createCommandHarness(new Map(), [], []);

		await harness.handler("other", harness.ctx);

		expect(harness.exec).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith("Usage: /branch or /branch new", "error");
	});
});
