// Spike harness. Copies the fixture project into fixtures/generated/<case>/, adds one file,
// runs each tool, and checks exit codes and reported rules. Then times the
// tools on generated corpora and removes the copies. Oxlint honors gitignore,
// so fixture sources must live outside .work/. Nothing leaves this folder.
import { cpSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { moduleSource, type CorpusShape } from "./gen.ts"

const root = import.meta.dir
const work = join(root, "fixtures/generated")
const bin = (name: string) => join(root, "node_modules/.bin", name)

type Tool = "tsc" | "oxlint" | "oxlint --type-check"
const commands: Record<Tool, string[]> = {
	tsc: [bin("tsc"), "-p", "."],
	oxlint: [bin("oxlint"), "src"],
	"oxlint --type-check": [bin("oxlint"), "--type-check", "src"],
}

const project = (name: string): string => {
	const dir = join(work, name)
	rmSync(dir, { recursive: true, force: true })
	mkdirSync(dir, { recursive: true })
	for (const entry of ["src", "tools", "tsconfig.json", ".oxlintrc.json", "package.json"]) {
		cpSync(join(root, entry), join(dir, entry), { recursive: true })
	}
	symlinkSync(join(root, "node_modules"), join(dir, "node_modules"))
	return dir
}

const run = (cwd: string, cmd: string[]) => {
	const start = performance.now()
	const proc = Bun.spawnSync(["/usr/bin/time", "-l", ...cmd], { cwd, stdout: "pipe", stderr: "pipe" })
	const ms = performance.now() - start
	const out = proc.stdout.toString()
	const err = proc.stderr.toString()
	const rss = Number(/(\d+)\s+maximum resident set size/.exec(err)?.[1] ?? 0)
	return { code: proc.exitCode, out: out + err, ms, rssMb: Math.round(rss / 1024 / 1024) }
}

// Each case: the file to add, and the text each tool must report (null = must pass).
type Case = { name: string; path: string; source: string; expect: Record<Tool, string | readonly string[] | null> }

const cases: Case[] = [
	{
		name: "clean",
		path: "src/core/clean.ts",
		source: `export const add = (a: number, b: number): number => a + b\n`,
		expect: { tsc: null, oxlint: null, "oxlint --type-check": null },
	},
	{
		name: "type error",
		path: "src/core/type-error.ts",
		source: `export const n: number = "x"\n`,
		expect: { tsc: "TS2322", oxlint: null, "oxlint --type-check": "TS2322" },
	},
	{
		name: "floating Effect",
		path: "src/core/floating-effect.ts",
		source: `import { Effect } from "effect"
export const program = Effect.gen(function* () {
	Effect.logInfo("lost")
	yield* Effect.logInfo("kept")
})
`,
		expect: { tsc: "floatingEffect", oxlint: "floating-effect", "oxlint --type-check": "floating-effect" },
	},
	{
		name: "type and Effect errors together",
		path: "src/core/combined-errors.ts",
		source: `import { Effect } from "effect"
export const n: number = "x"
export const program = Effect.gen(function* () {
	Effect.logInfo("lost")
	yield* Effect.logInfo("kept")
})
`,
		expect: { tsc: ["TS2322", "floatingEffect"], oxlint: "floating-effect", "oxlint --type-check": ["TS2322", "floating-effect"] },
	},
	{
		name: "floating promise (tsgolint)",
		path: "src/core/floating-promise.ts",
		source: `export const go = (): void => {
	fetch("http://localhost")
}
`,
		expect: { tsc: null, oxlint: "no-floating-promises", "oxlint --type-check": "no-floating-promises" },
	},
	{
		name: "module let in core (custom, scoped)",
		path: "src/core/counter.ts",
		source: `let counter = 0
export const next = (): number => ++counter
`,
		expect: { tsc: null, oxlint: "tau(no-module-let)", "oxlint --type-check": "tau(no-module-let)" },
	},
	{
		name: "module let in host (scoped off)",
		path: "src/host/counter.ts",
		source: `let counter = 0
export const next = (): number => ++counter
`,
		expect: { tsc: null, oxlint: null, "oxlint --type-check": null },
	},
	{
		name: "process.env in core (custom + Effect, scoped)",
		path: "src/core/env.ts",
		source: `export const home = (): string => process.env["HOME"] ?? "/"\n`,
		expect: { tsc: "processEnv", oxlint: "tau(no-process-env)", "oxlint --type-check": "tau(no-process-env)" },
	},
	{
		name: "process.env in host (scoped off)",
		path: "src/host/env.ts",
		source: `export const home2 = (): string => process.env["HOME"] ?? "/"\n`,
		expect: { tsc: null, oxlint: null, "oxlint --type-check": null },
	},
]

const checkCases = () => {
	let failures = 0
	for (const c of cases) {
		const dir = project(c.name.replace(/\W+/g, "-"))
		writeFileSync(join(dir, c.path), c.source)
		for (const tool of Object.keys(commands) as Tool[]) {
			const want = c.expect[tool]
			const r = run(dir, commands[tool])
			const messages = typeof want === "string" ? [want] : want
			const ok = messages === null ? r.code === 0 : r.code !== 0 && messages.every((message) => r.out.includes(message))
			if (!ok) failures++
			console.log(`${ok ? "PASS" : "FAIL"}  ${c.name.padEnd(46)} ${tool.padEnd(20)} exit=${r.code} want=${messages?.join(", ") ?? "pass"}`)
			if (!ok) console.log(r.out.split("\n").slice(0, 8).join("\n"))
		}
	}
	return failures
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0

const timeCorpus = (files: number, shape: CorpusShape) => {
	const dir = project(`corpus-${files}`)
	mkdirSync(join(dir, "src/core/gen"), { recursive: true })
	for (let i = 0; i < files; i++) writeFileSync(join(dir, `src/core/gen/m${i}.ts`), moduleSource(i, shape))
	// Variants that isolate each part's cost.
	writeFileSync(
		join(dir, ".oxlintrc.syntax.json"),
		JSON.stringify({ categories: { correctness: "error" }, jsPlugins: ["./tools/tau-plugin.js"], rules: { "tau/no-module-let": "error" } }),
	)
	writeFileSync(
		join(dir, ".oxlintrc.native.json"),
		JSON.stringify({ categories: { correctness: "error" }, options: { typeAware: true }, rules: { "typescript/no-floating-promises": "error" } }),
	)
	const variants: Record<string, string[]> = {
		"tsc (types + Effect)": commands.tsc,
		"oxlint (type-aware + Effect + JS plugin)": commands.oxlint,
		"oxlint --type-check (everything)": commands["oxlint --type-check"],
		"oxlint type-aware only, no Effect, no JS": [bin("oxlint"), "-c", ".oxlintrc.native.json", "src"],
		"oxlint syntax + JS plugin only": [bin("oxlint"), "-c", ".oxlintrc.syntax.json", "src"],
	}
	for (const [label, cmd] of Object.entries(variants)) {
		const runs = [run(dir, cmd), run(dir, cmd), run(dir, cmd)]
		const codes = new Set(runs.map((r) => r.code))
		const note = [...codes].every((c) => c === 0) ? "" : `  exit=${[...codes].join(",")} ${runs[0]?.out.split("\n")[0] ?? ""}`
		if (note !== "") process.exitCode = 1
		console.log(
			`${String(files).padStart(5)} files  ${label.padEnd(42)} ${(median(runs.map((r) => r.ms)) / 1000).toFixed(2)} s  ${median(runs.map((r) => r.rssMb))} MB${note}`,
		)
	}
}

try {
	const failures = checkCases()
	console.log(`\n${failures} failing checks\n`)
	if (failures > 0) {
		process.exitCode = 1
	} else {
		const shape = Bun.argv[3] ?? "bounded"
		if (shape !== "bounded" && shape !== "deep") throw new Error(`Unknown corpus shape: ${shape}`)
		const sizes = (Bun.argv[2] ?? "300,1000,3000").split(",").map(Number)
		console.log(`Corpus: ${shape}; median of three runs; fresh processes, warm filesystem\n`)
		for (const n of sizes) timeCorpus(n, shape)
	}
} finally {
	rmSync(work, { recursive: true, force: true })
}
