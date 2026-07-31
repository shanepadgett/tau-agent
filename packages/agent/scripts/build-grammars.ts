// Rebuilds the vendored grammar .wasm artifacts listed in
// packages/agent/src/ast/grammars/manifest.json.
//
// Grammars with source "vscode" ship prebuilt inside the
// @vscode/tree-sitter-wasm npm dependency and are never touched here.
// Grammars with source "built" are cloned at their pinned rev and compiled
// with the pinned tree-sitter-cli (which fetches the pinned wasi-sdk on
// first use). Grammars with source "release" are downloaded from their
// pinned upstream release asset.
//
// CI/maintainer-only. Run from the repo root on Linux (CI):
//   node --experimental-strip-types packages/agent/scripts/build-grammars.ts
//
// On the managed Mac, endpoint policy kills the wasi-sdk clang binary. Build
// inside a Linux container instead; see
// docs/plans/explore-wasm-rewrite/01-grammar-toolchain/README.md.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { grammarsDir, loadGrammarManifest } from "../src/ast/grammars/manifest.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..", "..");
const treeSitterBin = join(repoRoot, "node_modules", ".bin", "tree-sitter");

function run(command: string, args: readonly string[], cwd: string): void {
	const result = spawnSync(command, args, { cwd, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? "signal"}`);
	}
}

function capture(command: string, args: readonly string[]): string {
	const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? "signal"}`);
	return result.stdout.trim();
}

function installedVersion(packageName: string): string {
	const packageJson: unknown = JSON.parse(
		readFileSync(join(repoRoot, "node_modules", packageName, "package.json"), "utf8"),
	);
	if (typeof packageJson !== "object" || packageJson === null || !("version" in packageJson)) {
		throw new Error(`${packageName}: cannot read installed version`);
	}
	return String(packageJson.version);
}

const manifest = loadGrammarManifest();

for (const [packageName, pinned] of [
	["web-tree-sitter", manifest.webTreeSitter],
	["@vscode/tree-sitter-wasm", manifest.vscodeTreeSitterWasm],
] as const) {
	const found = installedVersion(packageName);
	if (found !== pinned) throw new Error(`${packageName} mismatch: manifest pins ${pinned}, found ${found}`);
}

const cliVersion = capture(treeSitterBin, ["--version"]);
if (cliVersion !== `tree-sitter ${manifest.treeSitterCli}`) {
	throw new Error(`tree-sitter-cli mismatch: manifest pins ${manifest.treeSitterCli}, found "${cliVersion}"`);
}

const workRoot = mkdtempSync(join(tmpdir(), "tau-grammars-"));
try {
	for (const grammar of manifest.grammars) {
		if (grammar.source === "vscode") continue;
		const outFile = join(grammarsDir, grammar.file);
		if (grammar.source === "release") {
			console.log(`[${grammar.id}] downloading ${grammar.url}`);
			const response = await fetch(grammar.url);
			if (!response.ok) throw new Error(`[${grammar.id}] download failed: HTTP ${response.status}`);
			writeFileSync(outFile, Buffer.from(await response.arrayBuffer()));
			continue;
		}
		const cloneDir = join(workRoot, grammar.id);
		run("git", ["init", "--quiet", cloneDir], workRoot);
		run("git", ["remote", "add", "origin", grammar.repo], cloneDir);
		run("git", ["fetch", "--quiet", "--depth", "1", "origin", grammar.rev], cloneDir);
		run("git", ["checkout", "--quiet", "FETCH_HEAD"], cloneDir);
		const grammarDir = grammar.subdir === "." ? cloneDir : join(cloneDir, grammar.subdir);
		if (!existsSync(join(grammarDir, "src", "parser.c"))) {
			console.log(`[${grammar.id}] generating parser.c`);
			run(treeSitterBin, ["generate"], grammarDir);
		}
		console.log(`[${grammar.id}] building ${grammar.file} from ${grammar.tag} (${grammar.rev})`);
		run(treeSitterBin, ["build", "--wasm", "-o", outFile, grammarDir], grammarDir);
	}
	console.log(`done: artifacts current in ${grammarsDir}`);
} finally {
	rmSync(workRoot, { recursive: true, force: true });
}
