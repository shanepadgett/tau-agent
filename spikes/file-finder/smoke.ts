// Compiled native correctness checks: ignoring, independent indexes, and updates.
import { FileFinder, type Result, type WatchEvent } from "@ff-labs/fff-bun"
import { mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const base = resolve(Bun.argv[2]!)
mkdirSync(base, { recursive: true })
const primary = join(base, "primary")
const secondary = join(base, "secondary")
for (const dir of [primary, secondary]) {
	rmSync(dir, { recursive: true, force: true })
	mkdirSync(join(dir, "src"), { recursive: true })
	const git = Bun.spawnSync(["git", "init", "-q", dir])
	if (git.exitCode !== 0) throw new Error(git.stderr.toString())
}
writeFileSync(join(primary, ".gitignore"), "ignored.txt\n")
writeFileSync(join(primary, "ignored.txt"), "ignored")
writeFileSync(join(primary, ".hidden.md"), "hidden")
writeFileSync(join(primary, "src/alpha.ts"), "export const alpha = 1")
writeFileSync(join(secondary, "src/beta.ts"), "export const beta = 2")
const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw new Error(result.error)
	return result.value
}
const first = unwrap(FileFinder.create({ basePath: primary, disableMmapCache: true, disableContentIndexing: true }))
const second = unwrap(FileFinder.create({ basePath: secondary, disableMmapCache: true, disableContentIndexing: true }))
const passed: string[] = []
const check = (condition: boolean, name: string) => {
	if (!condition) throw new Error(name)
	passed.push(name)
}
let waiting: ((events: WatchEvent[]) => void) | undefined
let unsubscribe = () => {}
try {
	check(unwrap(first.waitForScanBlocking(10_000)), "initial scan")
	check(unwrap(second.waitForScanBlocking(10_000)), "second scan")
	const files = unwrap(first.fileSearch("", { pageSize: 100 })).items.map((item) => item.relativePath)
	check(files.includes("src/alpha.ts"), "regular file indexed")
	check(files.includes(".hidden.md"), "hidden file indexed")
	check(!files.includes("ignored.txt"), "gitignore respected")
	check(!files.some((path) => path.startsWith(".git/")), "git metadata excluded")
	check(!unwrap(first.fileSearch("beta.ts")).items.some((item) => item.relativePath === "src/beta.ts"), "first index isolated")
	check(unwrap(second.fileSearch("beta.ts")).items.some((item) => item.relativePath === "src/beta.ts"), "second index isolated")
	const deadline = Date.now() + 10_000
	while (!unwrap(first.getScanProgress()).isWatcherReady) {
		if (Date.now() > deadline) throw new Error("Watcher readiness timeout")
		await Bun.sleep(10)
	}
	unsubscribe = unwrap(first.watch((events) => waiting?.(events)))
	const change = (action: () => void, matches: (event: WatchEvent) => boolean): Promise<void> => new Promise((done, fail) => {
		const timer = setTimeout(() => { waiting = undefined; fail(new Error("Watcher event timeout")) }, 10_000)
		waiting = (events) => {
			if (!events.some(matches)) return
			clearTimeout(timer)
			waiting = undefined
			done()
		}
		action()
	})
	await change(() => writeFileSync(join(primary, "src/new.ts"), "new"), (event) => event.kind === "created" && event.path === join(primary, "src/new.ts"))
	check(unwrap(first.fileSearch("new.ts")).items.some((item) => item.relativePath === "src/new.ts"), "created file searchable")
	await change(() => renameSync(join(primary, "src/new.ts"), join(primary, "src/renamed.ts")), (event) => event.kind === "renamed" && event.path === join(primary, "src/renamed.ts"))
	check(unwrap(first.fileSearch("renamed.ts")).items.some((item) => item.relativePath === "src/renamed.ts"), "renamed file searchable")
	await change(() => unlinkSync(join(primary, "src/renamed.ts")), (event) => event.kind === "removed" && event.path === join(primary, "src/renamed.ts"))
	check(!unwrap(first.fileSearch("renamed.ts")).items.some((item) => item.relativePath === "src/renamed.ts"), "deleted file absent")
	console.log(JSON.stringify({ platform: `${process.platform}-${process.arch}`, passed }))
} finally {
	unsubscribe()
	first.destroy()
	second.destroy()
}
