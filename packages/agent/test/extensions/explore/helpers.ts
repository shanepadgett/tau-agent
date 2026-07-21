import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { firstTextContent } from "../../../extensions/explore/result.ts";
import type { ToolRowStateStore } from "../../../shared/tool-row-state.ts";

export interface Workspace {
	dir: string;
	path(relativePath: string): string;
	write(relativePath: string, content: string): Promise<void>;
	mkdir(relativePath: string): Promise<void>;
	cleanup(): Promise<void>;
}

export async function createWorkspace(): Promise<Workspace> {
	const dir = await mkdtemp(join(tmpdir(), "tau-explore-test-"));
	return {
		dir,
		path(relativePath) {
			return join(dir, relativePath);
		},
		async write(relativePath, content) {
			const path = join(dir, relativePath);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content, "utf8");
		},
		async mkdir(relativePath) {
			await mkdir(join(dir, relativePath), { recursive: true });
		},
		async cleanup() {
			await rm(dir, { recursive: true, force: true });
		},
	};
}

export const testRowState: ToolRowStateStore = {
	get() {
		return undefined;
	},
	watch() {},
	clear() {},
};

export const testTheme = {
	fg(name: string, text: string) {
		return `<${name}>${text}</${name}>`;
	},
	bold(text: string) {
		return `*${text}*`;
	},
} as unknown as Theme;

export function extensionContext(cwd: string): ExtensionContext {
	return { cwd, model: undefined } as unknown as ExtensionContext;
}

export function branchExtensionContext(cwd: string, branch: unknown[]): ExtensionContext {
	return {
		...extensionContext(cwd),
		sessionManager: {
			getBranch: () => branch,
			getSessionId: () => "session",
			getLeafId: () => "leaf",
		},
	} as unknown as ExtensionContext;
}

interface TestToolRenderContext<TArgs> {
	args: TArgs;
	toolCallId: string;
	invalidate: () => void;
	lastComponent: Component | undefined;
	state: unknown;
	cwd: string;
	executionStarted: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	expanded: boolean;
	showImages: boolean;
	isError: boolean;
}

export function renderContext<TArgs>(args: TArgs, expanded: boolean, isError = false): TestToolRenderContext<TArgs> {
	return {
		args,
		toolCallId: "tool-call",
		invalidate() {},
		lastComponent: undefined,
		state: {},
		cwd: "",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded,
		showImages: false,
		isError,
	};
}

export const firstText = firstTextContent;

export function renderedText(component: Component | undefined): string {
	return component?.render(120).join("\n").trimEnd() ?? "";
}
