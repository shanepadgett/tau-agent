// Build separately, then pass the compiled executable to this runner.
// All mutable state, reports and Bun's temporary library files stay in .work/.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Dataset, Engine } from "./cases.ts"

const root = import.meta.dir
const work = join(root, ".work")
const binary = resolve(Bun.argv[2] ?? join(root, "dist/tau"))
const repeats = Number(Bun.argv[3] ?? 3)
const temp = join(work, "tmp")
mkdirSync(temp, { recursive: true })
mkdirSync(join(work, "home"), { recursive: true })
const reports: object[] = []
let nativeSnapshot: string | undefined
for (const dataset of ["opencode", "linux"] as Dataset[]) {
	for (const engine of ["fff", "fuzzysort", "fzf"] as Engine[]) {
		for (let iteration = 0; iteration < repeats; iteration++) {
			const command = process.platform === "darwin" ? ["/usr/bin/time", "-l"] : ["/usr/bin/time", "-v"]
			command.push(binary, engine, dataset, join(root, "corpus", dataset))
			const started = performance.now()
			const proc = Bun.spawnSync(command, {
				cwd: "/", stdout: "pipe", stderr: "pipe",
				env: { ...process.env, TMPDIR: temp, HOME: join(work, "home"), XDG_CACHE_HOME: join(work, "home/cache"), XDG_DATA_HOME: join(work, "home/data") },
			})
			if (proc.exitCode !== 0) throw new Error(`${engine}/${dataset}: exit ${proc.exitCode}\n${proc.stdout}\n${proc.stderr}`)
			const output = proc.stdout.toString().trim()
			const report = JSON.parse(output)
			if (engine === "fff") {
				if (report.nativeFiles.length > 1) throw new Error("Native library copies accumulated")
				const snapshot = JSON.stringify(report.nativeFiles)
				if (nativeSnapshot !== undefined && snapshot !== nativeSnapshot) throw new Error("Native library was replaced between processes")
				nativeSnapshot = snapshot
			}
			const stderr = proc.stderr.toString()
			const peak = process.platform === "darwin"
				? Number(/(\d+)\s+maximum resident set size/.exec(stderr)?.[1]) / 1048576
				: Number(/Maximum resident set size \(kbytes\):\s*(\d+)/.exec(stderr)?.[1]) / 1024
			if (!Number.isFinite(peak)) throw new Error(`Missing peak RSS: ${stderr}`)
			reports.push({ ...report, iteration, peakRssMiB: peak, processMs: performance.now() - started, tempAfter: readdirSync(temp) })
			console.log(`${dataset.padEnd(8)} ${engine.padEnd(10)} #${iteration + 1} ${report.files} files; first=${report.firstResultMs.toFixed(1)}ms query=${report.queryMedianMs.toFixed(2)}ms p95=${report.queryP95Ms.toFixed(2)}ms peak=${peak.toFixed(0)}MiB; native temp=${report.nativeFiles.length}`)
			writeFileSync(join(work, `${process.platform}-results.json`), JSON.stringify(reports, null, 2))
		}
	}
}
