// Runs the supervisor in a PTY, reads the screen through a headless xterm, and edits the app source.
// Phase 1: restart with draft kept, wait for a run, build failure, start-check failure,
// repeated crash with fallback, quit. Phase 2: a first build that keeps crashing, so the supervisor gives up.
// After each phase, a shell records the exit code and `stty -a` to check the terminal was restored.
// Usage: bun drive.ts [path to compiled supervisor].
import { strict as assert } from "node:assert";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import xterm from "@xterm/headless";

const here = import.meta.dir;
const work = join(here, "work");
const app = join(work, "app");
const binary = process.argv[2];
const started = performance.now();

function launch(direct?: string) {
	const supervisor = direct ? [process.execPath, direct] : binary ? [resolve(binary), app, work] : [process.execPath, join(here, "supervisor.ts"), app, work];
	const quoted = supervisor.map((part) => `'${part}'`).join(" ");
	const command = ["/bin/sh", "-c", `${quoted}; echo "exit $?" > '${work}/exit.txt'; stty -a > '${work}/stty.txt'`];
	const screen = new xterm.Terminal({ cols: 80, rows: 16, allowProposedApi: true });
	const terminal = new Bun.Terminal({ cols: 80, rows: 16, data: (_terminal, bytes) => screen.write(bytes) });
	const proc = Bun.spawn(command, { terminal, cwd: here, env: { ...process.env, TERM: "xterm-256color", STABLE_MS: "1500" } });
	const text = () => {
		const lines: string[] = [];
		for (let row = 0; row < screen.rows; row++) lines.push(screen.buffer.active.getLine(row)?.translateToString(true) ?? "");
		return lines.join("\n");
	};
	return { screen, terminal, proc, text };
}

type Session = ReturnType<typeof launch>;

const logLines = () => {
	try {
		return readFileSync(join(work, "supervisor.log"), "utf8").trim().split("\n");
	} catch {
		return [];
	}
};
const logged = (pattern: RegExp) => logLines().find((line) => pattern.test(line));
const loggedAt = (pattern: RegExp) => Number(logged(pattern)?.split(" ")[0]);
const setVersion = (body: string) => writeFileSync(join(app, "version.ts"), body);
const version = (name: string, crashAfterMs = 0) =>
	setVersion(`export const VERSION = "${name}";\nexport const CRASH_AFTER_MS = ${crashAfterMs};\n`);

async function until(session: Session, label: string, predicate: () => boolean, timeout = 8000) {
	const end = performance.now() + timeout;
	while (!predicate()) {
		if (performance.now() > end) throw new Error(`Timed out: ${label}\n--- screen ---\n${session.text()}\n--- log ---\n${logLines().join("\n")}`);
		await Bun.sleep(10);
	}
}

async function terminalAfterExit(session: Session, label: string) {
	await session.proc.exited;
	const exit = readFileSync(join(work, "exit.txt"), "utf8").trim();
	const stty = readFileSync(join(work, "stty.txt"), "utf8");
	const { modes, buffer } = session.screen;
	const restored = buffer.active.type === "normal" && modes.mouseTrackingMode === "none" && !modes.bracketedPasteMode && /(^|\s)icanon/.test(stty) && /(^|\s)echo(\s|$)/.test(stty) && /(^|\s)isig/.test(stty);
	console.log(`${label}: supervisor ${exit}; terminal restored ${restored} (buffer ${buffer.active.type}, mouse ${modes.mouseTrackingMode}, paste ${modes.bracketedPasteMode}, stty ${stty.split("\n")[1]?.trim()})`);
	return { exit, restored };
}

function fresh() {
	rmSync(work, { recursive: true, force: true });
	cpSync(join(here, "app"), app, { recursive: true });
}

async function phaseOne() {
	fresh();
	const session = launch();
	const { terminal, text } = session;
	const shows = (build: string) => text().includes(`Tau build ${build} |`);
	try {
		await until(session, "first frame", () => shows("1"), 15_000);
		console.log(`first frame after ${(performance.now() - started).toFixed(0)} ms`);

		// 1. An idle restart keeps the unsent draft. Measure how long no build is on screen.
		terminal.write("hello draft");
		await until(session, "draft typed", () => text().includes("hello draft"));
		await Bun.sleep(1600); // let build 1 become the last good build
		const edited = performance.now();
		version("2");
		await until(session, "build 1 leaves the screen", () => !shows("1"));
		const blank = performance.now();
		await until(session, "build 2 on screen", () => shows("2"));
		const back = performance.now();
		assert.ok(text().includes("hello draft"), "draft restored");
		console.log(`1 idle restart: edit to new frame ${(back - edited).toFixed(0)} ms, screen without a build ${(back - blank).toFixed(0)} ms, ${logged(/ready 2 gap/)?.split(" ").slice(1).join(" ")}`);

		// 2. A change during a run waits for the run to end.
		terminal.write("\r");
		await until(session, "run started", () => text().includes("| running"));
		version("3");
		await until(session, "pending notice", () => text().includes("restarts when this run ends"));
		await until(session, "build 3 on screen", () => shows("3"));
		const runEnded = loggedAt(/idle true/);
		const switched = loggedAt(/switch 2 -> 3/);
		assert.ok(switched >= runEnded, "switch waited for the run to end");
		console.log(`2 run in progress: switched ${switched - runEnded} ms after the run ended`);
		await Bun.sleep(1600); // build 3 becomes the last good build

		// 3. A syntax error fails the build; build 3 keeps running.
		setVersion(`export const VERSION = "x" +;\n`);
		await until(session, "build failure notice", () => text().includes("build failed"));
		assert.ok(shows("3"));
		console.log("3 build failure: build 3 kept, notice shown");

		// 4. Code that throws at start fails the headless check; build 3 keeps running.
		setVersion(`throw new Error("broken at start");\nexport const VERSION = "y";\nexport const CRASH_AFTER_MS = 0;\n`);
		await until(session, "start check notice", () => text().includes("start check failed"));
		assert.ok(shows("3"));
		console.log("4 start check failure: build 3 kept, notice shown");

		// 5. A build that passes the check but crashes soon after: restart once, then fall back.
		terminal.write("kept across crash");
		await until(session, "draft typed", () => text().includes("kept across crash"));
		version("4", 700);
		await until(session, "fallback", () => logged(/falling back to/) !== undefined, 15_000);
		await until(session, "build 3 on screen after fallback", () => shows("3"));
		console.log(`5 crash: ${logLines().filter((line) => / crash /.test(` ${line}`)).map((line) => line.split(" ").slice(1).join(" ")).join("; ")}`);
		assert.ok(text().includes("kept across crash"), "draft survives a crash");
		terminal.write(" typed");
		await until(session, "input works after fallback", () => text().includes("kept across crash typed"));
		console.log("5 crash: draft kept, input works after fallback");

		// 6. Ctrl-C quits the child and the supervisor, and the terminal is restored.
		terminal.write("\x03");
		const result = await terminalAfterExit(session, "6 quit");
		assert.equal(result.exit, "exit 0");
		assert.ok(result.restored);
	} finally {
		session.proc.kill();
		terminal.close();
	}
}

async function phaseTwo() {
	fresh();
	version("1", 700);
	const session = launch();
	try {
		const result = await terminalAfterExit(session, "7 first build keeps crashing");
		assert.equal(result.exit, "exit 1");
		console.log(`7 log: ${logLines().filter((line) => / crash /.test(` ${line}`)).map((line) => line.split(" ").slice(1).join(" ")).join("; ")}`);
		assert.ok(result.restored);
	} finally {
		session.proc.kill();
		session.terminal.close();
	}
}

// Control: the crashing build run alone, without the supervisor. Shows what a hard crash leaves behind.
async function control() {
	const entry = join(work, "builds", "1", "main.js");
	const session = launch(entry);
	try {
		await terminalAfterExit(session, "8 control, crashing build run alone");
	} finally {
		session.proc.kill();
		session.terminal.close();
	}
}

await phaseOne();
await phaseTwo();
await control();
console.log(`passed in ${(performance.now() - started).toFixed(0)} ms`);
