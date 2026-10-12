import { FileFinder } from "@ff-labs/fff-bun"
import { resolve } from "node:path"
import { enumerate } from "./inventory.ts"

const root = resolve(Bun.argv[2]!)
const created = FileFinder.create({ basePath: root, disableMmapCache: true, disableContentIndexing: true })
if (!created.ok) throw new Error(created.error)
const finder = created.value
try {
	const ready = finder.waitForScanBlocking(30_000)
	if (!ready.ok || !ready.value) throw new Error("Scan timeout")
	const result = finder.fileSearch("", { pageSize: 200_000 })
	if (!result.ok) throw new Error(result.error)
	const native = new Set(result.value.items.map((item) => item.relativePath))
	const js = new Set(enumerate(root))
	console.log(JSON.stringify({
		native: native.size, js: js.size, nativeTotal: result.value.totalFiles,
		onlyNative: [...native].filter((path) => !js.has(path)),
		onlyJs: [...js].filter((path) => !native.has(path)),
	}))
} finally {
	finder.destroy()
}
