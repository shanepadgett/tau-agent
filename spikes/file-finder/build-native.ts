// Embed an isolated native prototype without changing installed packages.
import { resolve } from "node:path"

const [entry, library, outfile] = Bun.argv.slice(2)
if (!entry || !library || !outfile) throw new Error("Usage: build-native.ts <entry> <library> <outfile>")
const result = await Bun.build({
	entrypoints: [resolve(entry)],
	target: "bun",
	compile: { outfile: resolve(outfile) },
	define: { FFF_LIBC: JSON.stringify("gnu") },
	plugins: [{
		name: "spike-native-library",
		setup(build) {
			build.onResolve({ filter: /^@ff-labs\/fff-bin-.*\/libfff_c\.(dylib|so)$/ }, () => ({ path: resolve(library) }))
		},
	}],
})
if (!result.success) throw new AggregateError(result.logs, "Native prototype compilation failed")
