// Spike host: compiled to a binary, loads a user extension from outside the binary,
// edits it, and reloads it with several cache strategies.
import { plugin } from "bun";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "./sdk.ts";

plugin({
	name: "tau-sdk",
	setup(build) {
		build.module("@shanepadgett/tau", () => ({ exports: { ...sdk }, loader: "object" }));
	},
});

function writeExtension(dir: string, version: string): void {
	writeFileSync(
		join(dir, "index.ts"),
		`import { defineExtension, instanceId } from "@shanepadgett/tau";
import { helper } from "./helper.ts";
import dep from "fake-dep";
const label: string = "entry=${version}";
defineExtension({ name: "demo", describe: () => \`\${label} \${helper} dep=\${dep} sameSdk=\${instanceId === "${sdk.instanceId}"}\` });
`,
	);
	writeFileSync(join(dir, "helper.ts"), `export const helper: string = "helper=${version}";\n`);
}

function makeExtensionDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "tau-ext-"));
	const dep = join(dir, "node_modules", "fake-dep");
	mkdirSync(dep, { recursive: true });
	writeFileSync(join(dep, "package.json"), `{"name":"fake-dep","main":"index.js"}`);
	writeFileSync(join(dep, "index.js"), `module.exports = "ok";\n`);
	// A local copy of the SDK, as an author's devDependency would install. It must not win.
	const shadow = join(dir, "node_modules", "@shanepadgett", "tau");
	mkdirSync(shadow, { recursive: true });
	writeFileSync(join(shadow, "package.json"), `{"name":"@shanepadgett/tau","main":"index.js"}`);
	writeFileSync(
		join(shadow, "index.js"),
		`exports.instanceId = "shadow"; exports.defineExtension = () => { throw new Error("shadow SDK used"); };\n`,
	);
	writeExtension(dir, "v1");
	return dir;
}

type Strategy = (entry: string, attempt: number, scratch: string) => Promise<void>;

const strategies: Record<string, Strategy> = {
	plain: async (entry) => {
		await import(entry);
	},
	query: async (entry, attempt) => {
		await import(`${entry}?v=${attempt}`);
	},
	"require-cache": async (entry) => {
		for (const key of Object.keys(require.cache)) {
			if (key.includes("tau-ext-")) delete require.cache[key];
		}
		await import(entry);
	},
	bundle: async (entry, attempt, scratch) => {
		const result = await Bun.build({
			entrypoints: [entry],
			target: "bun",
			format: "esm",
			external: ["@shanepadgett/tau"],
		});
		if (!result.success) throw new AggregateError(result.logs, "build failed");
		const [output] = result.outputs;
		if (!output) throw new Error("no build output");
		const file = join(scratch, `bundle-${attempt}.js`);
		writeFileSync(file, await output.text());
		await import(file);
	},
};

const only = process.argv[2];
for (const [name, load] of Object.entries(strategies)) {
	if (only && name !== only) continue;
	const dir = makeExtensionDir();
	const scratch = mkdtempSync(join(tmpdir(), "tau-scratch-"));
	const entry = join(dir, "index.ts");
	const lines: string[] = [];
	try {
		for (const [attempt, version] of ["v1", "v2"].entries()) {
			writeExtension(dir, version);
			sdk.registry.length = 0;
			const start = performance.now();
			await load(entry, attempt, scratch);
			const ms = (performance.now() - start).toFixed(1);
			lines.push(`${version}: ${sdk.registry.map((e) => e.describe()).join(" | ") || "(nothing registered)"} [${ms}ms]`);
		}
	} catch (error) {
		lines.push(`error: ${error instanceof Error ? error.message : String(error)}`);
	}
	console.log(`${name}\n  ${lines.join("\n  ")}`);
	rmSync(dir, { recursive: true, force: true });
	rmSync(scratch, { recursive: true, force: true });
}
