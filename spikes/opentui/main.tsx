// Entry: install runtime JSX support for extensions, load extension files given as args, then render.
// `--frame` renders headlessly with the test renderer, types a prompt, and prints the frame.
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure";
import { render, testRender } from "@opentui/solid";
import { resolve } from "node:path";
import * as sdk from "./sdk.ts";
import { App } from "./app.tsx";

const started = performance.now();
const args = process.argv.slice(2);
const frameMode = args.includes("--frame");
const extensions = args.filter((arg) => !arg.startsWith("--"));

ensureRuntimePluginSupport({ additional: { "@shanepadgett/tau": sdk } });
const pluginMs = performance.now() - started;

const loadStart = performance.now();
for (const file of extensions) await import(resolve(file));
const loadMs = performance.now() - loadStart;

if (frameMode) {
	const setup = await testRender(() => <App />, { width: 110, height: 32 });
	await setup.renderOnce();
	await setup.mockInput.typeText("hello");
	setup.mockInput.pressEnter();
	await setup.renderOnce();
	if (!setup.captureCharFrame().includes("hello")) throw new Error("Prompt did not appear immediately");
	let frame = "";
	for (let pass = 0; pass < 50; pass++) {
		await Bun.sleep(100);
		await setup.renderOnce();
		frame = setup.captureCharFrame();
		if (frame.includes("two") && frame.includes("ticks 000") && !frame.includes("ticks 0000")) break;
	}
	if (!frame.includes("add(") || !frame.includes("two") || frame.includes("tokens x2: 0")) {
		setup.renderer.destroy();
		throw new Error(`Streaming or extension reactivity failed:\n${frame}`);
	}
	console.log(frame);
	console.log({ pluginMs: pluginMs.toFixed(1), extensionLoadMs: loadMs.toFixed(1), totalMs: (performance.now() - started).toFixed(0), frameHadReply: frame.includes("add(") });
	setup.renderer.destroy();
	process.exit(0);
}

await render(() => <App />, { exitOnCtrlC: false });
