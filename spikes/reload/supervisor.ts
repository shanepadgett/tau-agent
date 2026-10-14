// Spike supervisor. Builds the app source into numbered bundles, checks a candidate headlessly,
// runs one child that owns the terminal, and switches to new code only when the child is idle.
// A child that crashes is restarted; a second crash of the same build within 10 s falls back to the last good build.
// Usage: supervisor.ts <source dir> <work dir>. Logs to <work dir>/supervisor.log; stdout belongs to the child.
import solidPlugin from "@opentui/solid/bun-plugin";
import { appendFileSync, mkdirSync, watch } from "node:fs";
import { join, resolve } from "node:path";

type Build = { id: number; entry: string };
type FromChild =
	| { type: "ready"; version: string }
	| { type: "idle"; idle: boolean }
	| { type: "draft"; draft: string };

const source = resolve(process.argv[2] ?? "app");
const work = resolve(process.argv[3] ?? "work");
const stableMs = Number(process.env.STABLE_MS ?? 10_000);
const crashWindowMs = 10_000;
const compiled = !/\/bun(-debug)?$/.test(process.execPath);
mkdirSync(join(work, "builds"), { recursive: true });

const logFile = join(work, "supervisor.log");
const log = (text: string) => appendFileSync(logFile, `${Date.now()} ${text}\n`);
const command = (entry: string, ...args: string[]) => [process.execPath, entry, ...args];
// OpenTUI imports every platform's native package; a bundle can only resolve the installed one.
const nativePackages = ["darwin-x64", "darwin-arm64", "linux-x64", "linux-x64-musl", "linux-arm64", "linux-arm64-musl", "win32-x64", "win32-arm64"];
const otherPlatforms = nativePackages.filter((name) => name !== `${process.platform}-${process.arch}`).map((name) => `@opentui/core-${name}`);
const env = { ...process.env, ...(compiled ? { BUN_BE_BUN: "1" } : {}) };

let builds = 0;
let child: Bun.Subprocess | undefined;
let current: Build | undefined;
let lastGood: Build | undefined;
let lastCrash = { id: -1, at: 0 };
let planned = false;
let idle = true;
let pending = false;
let switching = false;
let draft = "";
let idleWaiters: (() => void)[] = [];

async function build(): Promise<Build | string> {
	const id = ++builds;
	const outdir = join(work, "builds", String(id));
	const started = performance.now();
	try {
		const result = await Bun.build({ entrypoints: [join(source, "main.tsx")], outdir, target: "bun", plugins: [solidPlugin], external: otherPlatforms, publicPath: `${outdir}/` });
		if (!result.success) return result.logs.map(String).join("\n");
	} catch (error) {
		return error instanceof AggregateError ? error.errors.map(String).join("\n") : String(error);
	}
	log(`built ${id} in ${(performance.now() - started).toFixed(0)} ms`);
	return { id, entry: join(outdir, "main.js") };
}

async function check(candidate: Build): Promise<string | undefined> {
	const started = performance.now();
	const proc = Bun.spawn(command(candidate.entry, "--check"), { stdin: "ignore", stdout: "pipe", stderr: "pipe", env, timeout: 10_000 });
	const code = await proc.exited;
	log(`checked ${candidate.id}: exit ${code} in ${(performance.now() - started).toFixed(0)} ms`);
	if (code === 0) return undefined;
	const stderr = (await new Response(proc.stderr).text()).split("\n");
	return stderr.find((line) => line.startsWith("error:")) ?? `exit ${code}`;
}

function notify(text: string) {
	log(`notice: ${text}`);
	child?.send({ type: "notice", text });
}

function resetTerminal() {
	// Leave the alternate screen, show the cursor, reset colors, mouse, bracketed paste and the kitty keyboard mode.
	process.stdout.write("\x1b[?1049l\x1b[?25h\x1b[0m\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[<u");
}

function start(next: Build, switchStarted?: number) {
	const proc = Bun.spawn(command(next.entry), {
		stdio: ["inherit", "inherit", "inherit"],
		env: { ...env, TAU_DRAFT: draft },
		ipc(message: FromChild) {
			if (message.type === "ready") {
				const gap = switchStarted === undefined ? "" : ` gap ${(performance.now() - switchStarted).toFixed(0)} ms`;
				log(`ready ${next.id}${gap}`);
				setTimeout(() => {
					if (child === proc) {
						lastGood = next;
						log(`good ${next.id}`);
					}
				}, stableMs);
			}
			if (message.type === "idle") {
				idle = message.idle;
				log(`idle ${idle}`);
				if (idle) {
					for (const waiter of idleWaiters) waiter();
					idleWaiters = [];
				}
			}
			if (message.type === "draft") draft = message.draft;
		},
	});
	child = proc;
	current = next;
	idle = true;
	void proc.exited.then((code) => exited(next, proc, code));
}

function exited(build: Build, proc: Bun.Subprocess, code: number) {
	if (child !== proc) return;
	if (planned) return;
	if (code === 0) {
		log("quit");
		process.exit(0);
	}
	resetTerminal();
	const now = Date.now();
	const repeat = lastCrash.id === build.id && now - lastCrash.at < crashWindowMs;
	lastCrash = { id: build.id, at: now };
	if (!repeat) {
		log(`crash ${build.id}: exit ${code}, restarting it`);
		start(build);
		return;
	}
	if (lastGood && lastGood.id !== build.id) {
		log(`crash ${build.id} again: falling back to ${lastGood.id}`);
		start(lastGood);
		return;
	}
	log(`crash ${build.id} again with no good build: giving up`);
	process.exit(1);
}

const waitForIdle = () => (idle ? Promise.resolve() : new Promise<void>((done) => idleWaiters.push(done)));

async function restartWhenIdle() {
	if (switching || !pending) return;
	switching = true;
	pending = false;
	const candidate = await build();
	if (typeof candidate === "string") {
		notify(`build failed: ${candidate.split("\n")[0]}`);
	} else {
		const failure = await check(candidate);
		if (failure !== undefined) notify(`start check failed: ${failure}`);
		else {
			if (!idle) notify("Tau's code changed; it restarts when this run ends");
			await waitForIdle();
			log(`switch ${current?.id} -> ${candidate.id}`);
			const switchStarted = performance.now();
			planned = true;
			child?.send({ type: "exit-for-restart" });
			await child?.exited;
			planned = false;
			start(candidate, switchStarted);
		}
	}
	switching = false;
	if (pending) void restartWhenIdle();
}

process.on("SIGINT", () => log("SIGINT ignored"));

const first = await build();
if (typeof first === "string" || (await check(first)) !== undefined) {
	console.error(`first build failed: ${typeof first === "string" ? first : "start check"}`);
	process.exit(1);
}
log(`start ${first.id} compiled=${compiled}`);
start(first);

let debounce: ReturnType<typeof setTimeout> | undefined;
watch(source, { recursive: true }, () => {
	clearTimeout(debounce);
	debounce = setTimeout(() => {
		log("source changed");
		pending = true;
		notify("Tau's code changed; checking it");
		void restartWhenIdle();
	}, 100);
});
