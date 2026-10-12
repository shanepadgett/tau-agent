// Each invocation measures one engine in a fresh compiled process.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { cases, type Dataset, type Engine } from "./cases.ts"
import { enumerate } from "./inventory.ts"

const [engineArg, datasetArg, rootArg] = Bun.argv.slice(2)
if (engineArg !== "fff" && engineArg !== "fuzzysort" && engineArg !== "fzf") throw new Error("Unknown engine")
if (datasetArg !== "linux" && datasetArg !== "opencode") throw new Error("Unknown dataset")
if (!rootArg) throw new Error("Missing corpus directory")
const engine: Engine = engineArg
const dataset: Dataset = datasetArg
const root = resolve(rootArg)
const started = performance.now()
const baselineRss = process.memoryUsage().rss
let search: (query: string) => string[]
let destroy = () => {}
let waitForReady = async () => {}
let files: number

try {
	if (engine === "fff") {
		const { FileFinder } = await import("@ff-labs/fff-bun")
		const created = FileFinder.create({ basePath: root, disableMmapCache: true, disableContentIndexing: true })
		if (!created.ok) throw new Error(created.error)
		const finder = created.value
		destroy = () => finder.destroy()
		waitForReady = async () => {
			const ready = await finder.waitForIndexReady(30_000)
			if (!ready.ok || !ready.value) throw new Error(`Index warmup failed: ${JSON.stringify(ready)}`)
		}
		const scanned = finder.waitForScanBlocking(30_000)
		if (!scanned.ok || !scanned.value) throw new Error(`Scan failed: ${JSON.stringify(scanned)}`)
		const count = finder.fileSearch("", { pageSize: 10 })
		if (!count.ok) throw new Error(count.error)
		files = count.value.totalFiles
		search = (query) => {
			const result = finder.fileSearch(query, { pageSize: 10 })
			if (!result.ok) throw new Error(result.error)
			return result.value.items.map((item) => item.relativePath)
		}
	} else if (engine === "fuzzysort") {
		const { default: fuzzysort } = await import("fuzzysort")
		const paths = enumerate(root)
		files = paths.length
		const snapshot = fuzzysort.snapshot(paths)
		search = (query) => fuzzysort.go(query, snapshot, { limit: 10, threshold: 0 }).map((result) => result.target)
		destroy = () => fuzzysort.cleanup()
	} else {
		const { Fzf } = await import("fzf")
		const paths = enumerate(root)
		files = paths.length
		const finder = new Fzf(paths, { limit: 10 })
		search = (query) => finder.find(query).map((result) => result.item)
	}
	const indexedMs = performance.now() - started
	const first = search(cases[dataset][0]!.query)
	if (first.length === 0) throw new Error("First search returned no results")
	const firstResultMs = performance.now() - started
	await waitForReady()
	const readyMs = performance.now() - started
	const indexRss = process.memoryUsage().rss
	const ranking = cases[dataset].map((test) => {
		const top = search(test.query)
		const at = top.indexOf(test.target)
		return { ...test, rank: at < 0 ? null : at + 1, top }
	})
	const queries = [...cases[dataset].map((test) => test.query), ...(dataset === "linux" ? ["net", "core"] : ["src", "index"])]
	for (const query of queries) search(query)
	const samples: number[] = []
	for (let repeat = 0; repeat < 10; repeat++) {
		for (const query of queries) {
			const start = performance.now()
			search(query)
			samples.push(performance.now() - start)
		}
	}
	samples.sort((a, b) => a - b)
	const temp = process.env["TMPDIR"]
	const nativeFiles = temp ? readdirSync(temp).filter((name) => /\.(so|dylib)$/.test(name)).map((name) => {
		const stat = statSync(join(temp, name))
		return { name, size: stat.size, inode: stat.ino, mtimeMs: stat.mtimeMs }
	}) : []
	const nativeMappings = process.platform === "linux"
		? readFileSync("/proc/self/maps", "utf8").split("\n").filter((line) => /\/\.bun-.*\.so|\/memfd:|\.so.*\(deleted\)/.test(line))
		: []
	console.log(JSON.stringify({
		platform: `${process.platform}-${process.arch}`, engine, dataset, files,
		indexedMs, firstResultMs, readyMs, queryMedianMs: samples[Math.floor(samples.length / 2)], queryP95Ms: samples[Math.ceil(samples.length * 0.95) - 1],
		indexRssMiB: indexRss / 1048576, indexRssDeltaMiB: (indexRss - baselineRss) / 1048576,
		ranking, nativeFiles, nativeMappings,
	}))
} finally {
	destroy()
}
