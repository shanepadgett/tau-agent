// Compiles the supervisor into dist/tau. It then builds and runs the app bundles itself, as `BUN_BE_BUN=1 tau <bundle>`.
const result = await Bun.build({
	entrypoints: ["./supervisor.ts"],
	target: "bun",
	// A compiled binary reads bunfig.toml from the current folder by default; a project's preload would then break Tau.
	compile: { outfile: "./dist/tau", autoloadBunfig: false },
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
console.log("built dist/tau");
