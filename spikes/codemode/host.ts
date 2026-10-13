// Spike: can @opencode/codemode replace QuickJS as Tau's `run` tool?
// Cases: chained and parallel tool calls, Esc during a host call, Esc during a busy loop
// while the event loop keeps ticking, timeout, and one shared Effect copy.
import { CodeMode, Tool } from "@opencode/codemode"
import { Effect, Fiber, Schema } from "effect"

const sh = Tool.make({
	description: "Run a shell command and return its stdout",
	input: Schema.Struct({ command: Schema.String }),
	output: Schema.Struct({ output: Schema.String, exitCode: Schema.Number }),
	execute: ({ command }) =>
		Effect.callback<{ output: string; exitCode: number }>((resume, signal) => {
			const child = Bun.spawn(["sh", "-c", command], { stdout: "pipe", signal })
			void new Response(child.stdout).text().then(async (output) => {
				resume(Effect.succeed({ output, exitCode: await child.exited }))
			})
			return Effect.sync(() => child.kill())
		}),
})

const read = Tool.make({
	description: "Read a file",
	input: Schema.Struct({ path: Schema.String }),
	output: Schema.String,
	execute: ({ path }) => Effect.promise(() => Bun.file(path).text()),
})

const runtime = CodeMode.make({ tools: { sh, read }, limits: { timeoutMs: 10_000 } })

const results: Array<[string, boolean, string]> = []
const record = (name: string, pass: boolean, detail: string) => {
	results.push([name, pass, detail])
}

// Runs a program and interrupts it after `afterMs`, counting event-loop ticks meanwhile.
const runWithEsc = async (code: string, afterMs: number) => {
	let ticks = 0
	const ticker = setInterval(() => ticks++, 10)
	const start = performance.now()
	const fiber = Effect.runFork(runtime.execute(code))
	await new Promise((r) => setTimeout(r, afterMs))
	const ticksBeforeEsc = ticks
	await Effect.runPromise(Fiber.interrupt(fiber))
	clearInterval(ticker)
	return { elapsed: performance.now() - start, ticksBeforeEsc }
}

// 1. Chained awaits, parallel calls, try/catch around a failing call.
{
	const start = performance.now()
	const result = await Effect.runPromise(
		runtime.execute(`
			const pkg = JSON.parse(await tools.read({ path: "package.json" }))
			const both = await Promise.all([1, 2, 3].map(() => tools.sh({ command: "sleep 0.2; echo hi" })))
			let caught = "no"
			try { await tools.read({ path: "/nope" }) } catch (e) { caught = "yes" }
			return { name: pkg.name, outs: both.map((r) => r.output.trim()), caught }
		`),
	)
	const ms = performance.now() - start
	const value = result.ok ? JSON.stringify(result.value) : JSON.stringify(result.error)
	record("chained, parallel, try/catch", result.ok && ms < 400, `${Math.round(ms)} ms ${value}`)
}

// 2. Esc while awaiting `sleep 5`: the run ends and the child is killed.
{
	const { elapsed } = await runWithEsc(`await tools.sh({ command: "sleep 5" })`, 200)
	const left = Bun.spawnSync(["pgrep", "-f", "^sleep 5$"]).stdout.toString().trim()
	record("Esc during host call", elapsed < 400 && left === "", `${Math.round(elapsed)} ms, orphan: ${left || "none"}`)
}

// 3. Esc during `while (true) {}` on the main thread; the event loop must keep ticking.
{
	const { elapsed, ticksBeforeEsc } = await runWithEsc(`let i = 0; while (true) { i++ }`, 300)
	record("Esc during busy loop", elapsed < 500 && ticksBeforeEsc > 10, `${Math.round(elapsed)} ms, ${ticksBeforeEsc} ticks in 300 ms`)
}

// 4. Timeout limit on a busy loop.
{
	const quick = CodeMode.make({ tools: { sh }, limits: { timeoutMs: 300 } })
	const start = performance.now()
	const result = await Effect.runPromise(quick.execute(`while (true) {}`))
	const ms = performance.now() - start
	const kind = result.ok ? "ok" : result.error.kind
	record("timeout on busy loop", kind === "TimeoutExceeded" && ms < 600, `${Math.round(ms)} ms, ${kind}`)
}

// 5. Loop speed: one million iterations of plain arithmetic.
{
	const start = performance.now()
	const result = await Effect.runPromise(runtime.execute(`let s = 0; for (let i = 0; i < 1e6; i++) { s += i } return s`))
	record("1e6-iteration loop", result.ok, `${Math.round(performance.now() - start)} ms`)
}

// 6. A Schema from Tau's Effect copy decodes inside the package (one shared Effect).
{
	const result = await Effect.runPromise(runtime.execute(`return await tools.sh({ command: 42 })`))
	const kind = result.ok ? "ok" : result.error.kind
	record("Tau's Schema decodes input", kind === "InvalidToolInput", kind)
}

for (const [name, pass, detail] of results) console.log(`${pass ? "PASS" : "FAIL"}  ${name}: ${detail}`)
process.exit(results.every(([, pass]) => pass) ? 0 : 1)
