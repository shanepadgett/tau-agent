import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type VscodeGrammarPin = {
	id: string;
	source: "vscode";
	file: string;
};

export type BuiltGrammarPin = {
	id: string;
	source: "built";
	file: string;
	repo: string;
	tag: string;
	rev: string;
	subdir: string;
};

export type ReleaseGrammarPin = {
	id: string;
	source: "release";
	file: string;
	repo: string;
	tag: string;
	rev: string;
	url: string;
};

export type GrammarPin = VscodeGrammarPin | BuiltGrammarPin | ReleaseGrammarPin;

export type GrammarManifest = {
	webTreeSitter: string;
	vscodeTreeSitterWasm: string;
	treeSitterCli: string;
	wasiSdk: string;
	grammars: GrammarPin[];
};

export const grammarsDir = dirname(fileURLToPath(import.meta.url));
const resolveModule = createRequire(import.meta.url).resolve;

export function runtimeWasmPath(): string {
	return join(dirname(resolveModule("web-tree-sitter")), "web-tree-sitter.wasm");
}

export function grammarWasmPath(pin: GrammarPin): string {
	if (pin.source === "vscode") {
		return join(dirname(resolveModule("@vscode/tree-sitter-wasm")), pin.file);
	}
	return join(grammarsDir, pin.file);
}

function requireString(record: Record<string, unknown>, key: string, context: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`grammar manifest: ${context}.${key} must be a non-empty string`);
	}
	return value;
}

function parseGrammarPin(entry: unknown, index: number): GrammarPin {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		throw new Error(`grammar manifest: grammars[${index}] must be an object`);
	}
	const record = entry as Record<string, unknown>;
	const context = `grammars[${index}]`;
	const id = requireString(record, "id", context);
	const file = requireString(record, "file", context);
	const source = requireString(record, "source", context);
	if (source === "vscode") return { id, source, file };
	const repo = requireString(record, "repo", context);
	const tag = requireString(record, "tag", context);
	const rev = requireString(record, "rev", context);
	if (source === "built") return { id, source, file, repo, tag, rev, subdir: requireString(record, "subdir", context) };
	if (source === "release") return { id, source, file, repo, tag, rev, url: requireString(record, "url", context) };
	throw new Error(`grammar manifest: ${context}.source must be vscode, built, or release`);
}

export function loadGrammarManifest(): GrammarManifest {
	const parsed: unknown = JSON.parse(readFileSync(join(grammarsDir, "manifest.json"), "utf8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("grammar manifest: root must be an object");
	}
	const root = parsed as Record<string, unknown>;
	if (!Array.isArray(root.grammars) || root.grammars.length === 0) {
		throw new Error("grammar manifest: grammars must be a non-empty array");
	}
	return {
		webTreeSitter: requireString(root, "webTreeSitter", "root"),
		vscodeTreeSitterWasm: requireString(root, "vscodeTreeSitterWasm", "root"),
		treeSitterCli: requireString(root, "treeSitterCli", "root"),
		wasiSdk: requireString(root, "wasiSdk", "root"),
		grammars: root.grammars.map(parseGrammarPin),
	};
}
