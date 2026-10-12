import solidPlugin from "@opentui/solid/bun-plugin";

const result = await Bun.build({
	entrypoints: ["./main.tsx"],
	target: "bun",
	plugins: [solidPlugin],
	compile: { outfile: "./dist/tau" },
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
console.log("built dist/tau");
