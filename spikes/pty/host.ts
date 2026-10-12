// Throwaway PTY experiment. No dependencies; compile with Bun.
import { strict as assert } from "node:assert";
import { stripVTControlCharacters } from "node:util";

const mode = process.argv[2];
if (mode === "--server") {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response("pty-server-ok"),
	});
	console.log(`SERVER ${process.pid} ${server.port}`);
	await new Promise(() => {});
}

const self = process.execPath.endsWith("/bun")
	? [process.execPath, import.meta.path]
	: [process.execPath];
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const decoder = new TextDecoder();

async function until(predicate: () => boolean, label: string, timeout = 5000) {
	const end = performance.now() + timeout;
	while (!predicate()) {
		if (performance.now() > end) throw new Error(`Timed out: ${label}`);
		await Bun.sleep(20);
	}
}

function spawn(cmd: string[]) {
	let output = "";
	const terminal = new Bun.Terminal({
		cols: 80,
		rows: 24,
		data(_terminal, bytes) { output += decoder.decode(bytes); },
	});
	const proc = Bun.spawn(cmd, {
		terminal,
		detached: true,
		env: { ...process.env, TERM: "xterm-256color", PS1: "PTY> " },
	});
	return {
		proc, terminal,
		output: () => output,
		clear: () => { output = ""; },
	};
}

function alive(pid: number) {
	try { process.kill(pid, 0); return true; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

function processTable() {
	const result = Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid=,pgid="]);
	assert.equal(result.exitCode, 0);
	return result.stdout.toString().trim().split("\n").map((line) => {
		const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
		return { pid, ppid, pgid };
	});
}

// Snapshot owned descendants before signaling the root. Shell job control can
// place children in other process groups, so killing only -rootPid is not enough.
async function killTree(session: ReturnType<typeof spawn>) {
	const table = processTable();
	const owned = new Set([session.proc.pid]);
	for (let changed = true; changed;) {
		changed = false;
		for (const row of table) {
			if (owned.has(row.ppid) && !owned.has(row.pid)) {
				owned.add(row.pid);
				changed = true;
			}
		}
	}
	const descendants = [...owned].filter((pid) => pid !== session.proc.pid).reverse();
	assert.ok(!owned.has(process.pid), "refusing to signal spike host");
	console.log("cleanup", { host: process.pid, root: session.proc.pid, owned: table.filter((row) => owned.has(row.pid)) });
	const signal = (pid: number, name: NodeJS.Signals) => {
		try { process.kill(pid, name); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
	};
	// Let a live parent reap its children before terminating it.
	for (const pid of descendants) signal(pid, "SIGTERM");
	await Bun.sleep(200);
	for (const pid of descendants) if (alive(pid)) signal(pid, "SIGKILL");
	await Bun.sleep(100);
	if (alive(session.proc.pid)) session.proc.kill("SIGTERM");
	await Promise.race([session.proc.exited, Bun.sleep(500)]);
	if (alive(session.proc.pid)) session.proc.kill("SIGKILL");
	await session.proc.exited;
	session.terminal.close();
	await until(() => [...owned].every((pid) => !alive(pid)), "all owned processes exited");
	return table.filter((row) => owned.has(row.pid));
}

const started = performance.now();

// Interactive shell and window size. Disable echo so assertions cannot match input.
const shell = spawn(["/bin/bash", "--noprofile", "--norc", "-i"]);
try {
	await until(() => shell.output().includes("PTY>"), "shell prompt");
	shell.terminal.write("stty -echo; printf '\\nREADY\\n'\n");
	await until(() => shell.output().includes("\r\nREADY\r\n"), "shell ready");
	shell.clear();
	shell.terminal.write("test -t 0 && test -t 1 && test -t 2 && echo ALL_TTY; stty size\n");
	await until(() => shell.output().includes("ALL_TTY") && shell.output().includes("24 80"), "TTY and initial size");
	shell.clear();
	shell.terminal.resize(120, 40);
	shell.terminal.write("stty size\n");
	await until(() => shell.output().includes("40 120"), "resized terminal");
	console.log("shell: input, TTY, resize OK");
} catch (error) {
	console.error("shell output:", JSON.stringify(shell.output()));
	throw error;
} finally { await killTree(shell); }

const python = spawn([process.env.PYTHON ?? "/usr/bin/python3", "-i", "-q"]);
try {
	await until(() => python.output().includes(">>>"), "python prompt");
	python.terminal.write("import sys; print('PY_TTY', sys.stdin.isatty(), sys.stdout.isatty()); print(6 * 7)\n");
	await until(() => python.output().includes("PY_TTY True True") && python.output().includes("\r\n42\r\n"), "python interactive response");
	console.log("python: interactive input and TTY OK");
} finally { await killTree(python); }

// Job-control shell: server and nested shell/sleep use different process groups.
const tree = spawn(["/bin/bash", "--noprofile", "--norc", "-i"]);
console.log("server command", self);
let port = 0;
try {
	await until(() => tree.output().includes("PTY>"), "tree shell prompt");
	tree.terminal.write(`${self.map(quote).join(" ")} --server &\n`);
	await until(() => /SERVER \d+ \d+/.test(tree.output()), "server startup");
	const match = tree.output().match(/SERVER (\d+) (\d+)/)!;
	port = Number(match[2]);
	tree.terminal.write("/bin/sh -c '/bin/sleep 300 & wait' &\n");
	await until(() => processTable().some((row) => row.ppid === tree.proc.pid && row.pid !== Number(match[1])), "nested child");
	await Bun.sleep(100);
	async function toolCall() {
		const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) });
		assert.equal(await response.text(), "pty-server-ok");
	}
	await toolCall();
	await Bun.sleep(300);
	await toolCall();
	console.log("server: alive across two simulated tool calls OK");
} finally {
	const killed = await killTree(tree);
	assert.ok(killed.length >= 4, "expected shell, server, nested shell and sleep");
	assert.ok(new Set(killed.map((row) => row.pgid)).size > 1, "expected job-control process groups");
	console.log("tree: no surviving PIDs", killed);
}
let closed = false;
try { await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) }); }
catch { closed = true; }
assert.ok(closed, "server still listening after cleanup");

if (process.env.TAU_TUI && process.env.TAU_TUI_EXTENSION) {
	const tui = spawn([process.env.TAU_TUI, process.env.TAU_TUI_EXTENSION]);
	tui.terminal.resize(110, 32);
	try {
		await until(() => stripVTControlCharacters(tui.output()).includes("Type a prompt"), "interactive TUI startup");
		tui.terminal.write("hello\r");
		await until(() => {
			const output = stripVTControlCharacters(tui.output());
			return output.includes("markdown reply") && output.includes("tokens x2:");
		}, "interactive TUI reply");
		tui.terminal.write("\x03");
		await until(() => tui.proc.exitCode !== null, "interactive TUI Ctrl-C exit");
		assert.equal(await tui.proc.exited, 0);
		console.log("OpenTUI: interactive terminal startup, prompt, streaming and Ctrl-C OK");
	} finally { await killTree(tui); }
}
console.log(`passed in ${(performance.now() - started).toFixed(0)} ms`);
