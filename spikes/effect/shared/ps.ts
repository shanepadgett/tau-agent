// Process-table helpers shared by both versions (Effect does not change these).

export function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

export function signal(pid: number, name: NodeJS.Signals) {
	try {
		process.kill(pid, name);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

// Descendants of root, deepest first. Snapshot before signalling anything.
export function descendants(root: number): number[] {
	const result = Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid="]);
	if (result.exitCode !== 0) throw new Error("ps failed");
	const rows = result.stdout.toString().trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
	const owned = new Set([root]);
	for (let changed = true; changed; ) {
		changed = false;
		for (const [pid, ppid] of rows) {
			if (pid !== undefined && ppid !== undefined && owned.has(ppid) && !owned.has(pid)) {
				owned.add(pid);
				changed = true;
			}
		}
	}
	owned.delete(root);
	if (owned.has(process.pid)) throw new Error("refusing to signal host");
	return [...owned].reverse();
}

// Shell command that leaves a job-control tree: bash -> sleep, bash -> sh -> sleep.
export const TREE_COMMANDS = "sleep 300 &\n/bin/sh -c '/bin/sleep 300 & wait' &\nprintf 'TREE_%s\\n' READY\n";
