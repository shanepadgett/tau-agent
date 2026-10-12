// Spike host: one QuickJS sandbox with async host functions, run from a compiled binary.
import wasmPath from "quickjs-wasi/quickjs.wasm" with { type: "file" };
import { QuickJS, type JSValueHandle } from "quickjs-wasi";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let start = performance.now();
const wasm = await WebAssembly.compile(await Bun.file(wasmPath).arrayBuffer());
console.log(`wasm compile: ${(performance.now() - start).toFixed(1)}ms`);

const server = Bun.serve({ port: 0, fetch: () => new Response("hello from http") });
const scratch = mkdtempSync(join(tmpdir(), "tau-sandbox-"));
const sampleFile = join(scratch, "sample.txt");
writeFileSync(sampleFile, "line one\nline two\n");

type HostFunction = (args: unknown[], signal: AbortSignal) => Promise<string>;

const hostFunctions: Record<string, HostFunction> = {
	read: async ([path]) => Bun.file(String(path)).text(),
	bash: async ([command], signal) => {
		const child = Bun.spawn(["bash", "-c", String(command)], { stdout: "pipe", signal });
		const text = await new Response(child.stdout).text();
		const code = await child.exited;
		if (signal.aborted) throw new Error(`aborted (exit ${code})`);
		return text.trim();
	},
	http: async ([url], signal) => (await fetch(String(url), { signal })).text(),
};

async function run(name: string, code: string, options: { deadlineMs: number; abortAfterMs: number }) {
	const controller = new AbortController();
	const output: string[] = [];
	let ticks = 0;
	const ticker = setInterval(() => ticks++, 10);
	const abortTimer = setTimeout(() => controller.abort(), options.abortAfterMs);
	start = performance.now();
	const deadline = start + options.deadlineMs;
	let interruptChecks = 0;
	let disposed = false;
	const vm = await QuickJS.create({
		wasm,
		interruptHandler: () => {
			if (controller.signal.aborted) return true;
			interruptChecks++;
			return (interruptChecks & 1023) === 0 && performance.now() > deadline;
		},
	});
	const createMs = performance.now() - start;

	const log = vm.newFunction("log", (...args: JSValueHandle[]) => {
		output.push(args.map((arg) => arg.toString()).join(" "));
		return vm.getUndefined();
	});
	vm.setProp(vm.global, "log", log);
	log.dispose();
	for (const [fnName, impl] of Object.entries(hostFunctions)) {
		const fn = vm.newFunction(fnName, (...args: JSValueHandle[]) => {
			const deferred = vm.newPromise();
			impl(
				args.map((arg) => vm.dump(arg)),
				controller.signal,
			).then(
				(value) => {
					if (disposed) return;
					const handle = vm.newString(value);
					deferred.resolve(handle);
					handle.dispose();
					vm.executePendingJobs();
				},
				(error: unknown) => {
					if (disposed) return;
					const handle = vm.newError(error instanceof Error ? error : String(error));
					deferred.reject(handle);
					handle.dispose();
					vm.executePendingJobs();
				},
			);
			return deferred.handle;
		});
		vm.setProp(vm.global, fnName, fn);
		fn.dispose();
	}

	let outcome: string;
	try {
		const promise = vm.evalCode(`(async () => {\n${code}\n})()`, "script.js");
		vm.executePendingJobs();
		const aborted = new Promise<{ aborted: true }>((resolve) =>
			controller.signal.addEventListener("abort", () => resolve({ aborted: true })),
		);
		const settled = await Promise.race([vm.resolvePromise(promise), aborted]);
		if ("aborted" in settled) outcome = "aborted while awaiting";
		else if ("error" in settled) outcome = `script error: ${settled.error.toString()}`;
		else outcome = "ok";
		promise.dispose();
	} catch (error) {
		outcome = `threw: ${error instanceof Error ? error.message : String(error)}`;
	}
	clearInterval(ticker);
	clearTimeout(abortTimer);
	const totalMs = performance.now() - start;
	disposed = true;
	vm.dispose();
	console.log(
		`${name}\n  outcome: ${outcome}\n  vm create: ${createMs.toFixed(1)}ms, total: ${totalMs.toFixed(0)}ms, event-loop ticks: ${ticks}`,
	);
	for (const line of output) console.log(`  > ${line}`);
}

await run(
	"chained async host calls",
	`const text = await read(${JSON.stringify(sampleFile)});
log("lines:", text.split("\\n").filter(Boolean).length);
log("bash:", await bash("echo $((6 * 7))"));
log("http:", await http(${JSON.stringify(server.url.href)}));
const parallel = await Promise.all([bash("sleep 0.2; echo a"), bash("sleep 0.2; echo b"), bash("sleep 0.2; echo c")]);
log("parallel:", parallel.join(","));
try { await read("/does/not/exist"); } catch (e) { log("caught:", e.message.slice(0, 40)); }`,
	{ deadlineMs: 10_000, abortAfterMs: 10_000 },
);

await run(
	"cancel during awaited bash",
	`log("starting sleep"); await bash("sleep 5"); log("should not print");`,
	{ deadlineMs: 10_000, abortAfterMs: 200 },
);

await run("cpu loop on main thread, 300ms deadline", `log("looping"); while (true) {}`, {
	deadlineMs: 300,
	abortAfterMs: 10_000,
});

await run("cpu work: 1e6 loop iterations with interrupt checks", `let s = 0; for (let i = 0; i < 1e6; i++) s += i; log(s);`, {
	deadlineMs: 10_000,
	abortAfterMs: 10_000,
});

{
	const flag = new Int32Array(new SharedArrayBuffer(4));
	const worker = new Worker(new URL("./worker.ts", import.meta.url).href);
	let ticks = 0;
	const ticker = setInterval(() => ticks++, 10);
	start = performance.now();
	const result = await new Promise<string>((resolve) => {
		worker.onmessage = (event: MessageEvent<string>) => resolve(event.data);
		worker.onerror = (event) => resolve(`worker error: ${event.message}`);
		worker.postMessage({ code: "while (true) {}", flag });
		setTimeout(() => Atomics.store(flag, 0, 1), 300);
	});
	clearInterval(ticker);
	worker.terminate();
	console.log(
		`cpu loop in worker, host aborts at 300ms\n  outcome: ${result}\n  total: ${(performance.now() - start).toFixed(0)}ms, event-loop ticks: ${ticks}`,
	);
}

server.stop(true);
rmSync(scratch, { recursive: true, force: true });
