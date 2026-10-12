// Diagnose native ranking before changing any matching or scoring policy.
import { FileFinder, type Result } from "@ff-labs/fff-bun"
import { resolve } from "node:path"
import { cases } from "./cases.ts"

const dataset = Bun.argv[2]
if (dataset !== "opencode" && dataset !== "linux") throw new Error("Unknown dataset")
const root = resolve(Bun.argv[3]!)
const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw new Error(result.error)
	return result.value
}
const finder = unwrap(FileFinder.create({ basePath: root, disableMmapCache: true, disableContentIndexing: true }))
const query = dataset === "opencode" ? "schemasession" : "netsocket"
const target = cases[dataset].find((item) => item.query === query)!.target
const samples: object[] = []
const probe = (phase: string) => {
	for (const maxThreads of [0, 1, 4]) {
		for (const pageSize of [10, 100, 200_000]) {
			const start = performance.now()
			const result = unwrap(finder.fileSearch(query, { pageSize, maxThreads }))
			const at = result.items.findIndex((item) => item.relativePath === target)
			samples.push({
				phase, maxThreads, pageSize, elapsedMs: performance.now() - start,
				totalFiles: result.totalFiles, totalMatched: result.totalMatched,
				returned: result.items.length, targetRank: at < 0 ? null : at + 1,
				targetItem: at < 0 ? null : result.items[at], targetScore: at < 0 ? null : result.scores[at],
				top: result.items.slice(0, 10).map((item, index) => ({ path: item.relativePath, score: result.scores[index] })),
			})
		}
	}
}
try {
	if (!unwrap(finder.waitForScanBlocking(30_000))) throw new Error("Scan timeout")
	probe("scanned")
	if (!unwrap(await finder.waitForIndexReady(30_000))) throw new Error("Index timeout")
	probe("ready")
	await Bun.sleep(250)
	unwrap(finder.refreshGitStatus())
	probe("git-refreshed")
	const ranking = cases[dataset].map((test) => {
		const result = unwrap(finder.fileSearch(test.query, { pageSize: 10 }))
		const at = result.items.findIndex((item) => item.relativePath === test.target)
		return { ...test, rank: at < 0 ? null : at + 1 }
	})
	console.log(JSON.stringify({ platform: `${process.platform}-${process.arch}`, query, target, progress: unwrap(finder.getScanProgress()), samples, ranking }))
} finally {
	finder.destroy()
}
