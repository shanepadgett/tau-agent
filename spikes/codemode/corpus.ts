// Runs every distinct `codemode` script from local Pi sessions through @opencode/codemode with stub tools,
// and counts parse errors, unsupported syntax and other failures. Reads sessions; writes nothing.
import { CodeMode, Extension, Tool } from "@opencode/codemode"
import { Effect } from "effect"
import { Glob } from "bun"
import * as acorn from "acorn"

const AsyncFunction = (async () => {}).constructor as new (body: string) => unknown

const root = `${process.env.HOME}/.pi/agent/sessions`
const scripts = new Set<string>()
for await (const path of new Glob("**/*.jsonl").scan(root)) {
	for (const line of (await Bun.file(`${root}/${path}`).text()).split("\n")) {
		if (!line.includes('"name":"codemode"')) continue
		const entry = JSON.parse(line)
		for (const part of entry.message?.content ?? []) {
			if (part.type === "toolCall" && part.name === "codemode" && typeof part.arguments?.code === "string") {
				scripts.add(part.arguments.code)
			}
		}
	}
}

// Pi tools resolve to strings, except bash, which resolves to an object.
const names = new Set<string>()
for (const code of scripts) for (const [, name] of code.matchAll(/tools\.(\w+)/g)) names.add(name)
const stub = (name: string) =>
	Tool.make({
		description: `stub ${name}`,
		input: { type: "object" },
		output: {},
		execute: () =>
			Effect.succeed(name === "bash" ? { output: "", exit_code: 0, truncated: false, wall_time_seconds: 0 } : ""),
	})
const tools = Object.fromEntries([...names].map((name) => [name, stub(name)]))
const piGlobals = Extension.make({
	name: "pi",
	globals: {
		text: () => null,
		image: () => null,
		store: () => null,
		load: () => null,
		exit: () => null,
		searchTools: () => [],
		describeTool: () => "",
	},
})
const runtime = CodeMode.make({ tools, extensions: [piGlobals], limits: { timeoutMs: 2000 } })

const counts = new Map<string, number>()
const messages = new Map<string, number>()
for (const code of scripts) {
	const result = await Effect.runPromise(runtime.execute(code))
	const kind = result.ok ? "ok" : result.error.kind
	counts.set(kind, (counts.get(kind) ?? 0) + 1)
	if (kind === "ParseError") {
		let jsc = "parses in JSC"
		try {
			new AsyncFunction(code)
		} catch (e) {
			jsc = `JSC also rejects: ${String(e).slice(0, 60)}`
		}
		console.log(`parse error: ${jsc}`)
	}
	if (!result.ok && result.error.message.startsWith("ReferenceError")) console.log(`reference: ${result.error.message}`)
	if (!result.ok && kind !== "ToolFailure") {
		const message = result.error.message.replace(/\(line \d+, col \d+\)/, "").replace(/'[^']*'/g, "'…'").slice(0, 110)
		messages.set(`${kind}: ${message}`, (messages.get(`${kind}: ${message}`) ?? 0) + 1)
	}
}

// Static scan: syntax the interpreter lists as unsupported, found anywhere in a script, reached or not.
const unsupported = new Map<string, number>()
const visit = (node: unknown): void => {
	if (Array.isArray(node)) return node.forEach(visit)
	if (node === null || typeof node !== "object") return
	const n = node as Record<string, unknown>
	const type = n.type as string | undefined
	let hit: string | undefined
	if (type === "ClassDeclaration" || type === "ClassExpression") hit = "class"
	else if (type === "Property" && (n.kind === "get" || n.kind === "set")) hit = "getter/setter"
	else if (type === "Literal" && "bigint" in n) hit = "BigInt"
	else if (type === "NewExpression" && (n.callee as Record<string, unknown>)?.type === "Identifier") {
		const name = (n.callee as Record<string, unknown>).name as string
		if (!["Map", "Set", "Date", "RegExp", "URL", "Error", "TypeError", "Promise", "Array", "Object", "URLSearchParams", "TextEncoder", "TextDecoder", "WeakMap", "WeakSet", "RangeError", "Intl"].includes(name)) hit = `new ${name}`
	}
	if (hit) unsupported.set(hit, (unsupported.get(hit) ?? 0) + 1)
	for (const value of Object.values(n)) if (typeof value === "object") visit(value)
}
for (const code of scripts) {
	try {
		visit(acorn.parse(code, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }))
	} catch {}
}

console.log(`${scripts.size} distinct scripts, ${names.size} tool names`)
console.log(`static scan, unsupported syntax present: ${JSON.stringify(Object.fromEntries(unsupported))}`)
for (const [kind, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(4)}  ${kind}`)
console.log("\nfailure messages:")
for (const [message, n] of [...messages].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${String(n).padStart(4)}  ${message}`)
