// Stand-in for Tau's TUI and core, run as the supervisor's child.
// `--check` renders one frame headlessly and exits 0 when the frame shows this build's version.
import { render, testRender } from "@opentui/solid";
import { App } from "./app.tsx";
import { VERSION } from "./version.ts";

if (process.argv.includes("--check")) {
	const setup = await testRender(() => <App draft="" />, { width: 80, height: 20 });
	await setup.renderOnce();
	const frame = setup.captureCharFrame();
	setup.renderer.destroy();
	if (!frame.includes(`build ${VERSION}`)) {
		console.error(frame);
		process.exit(1);
	}
	process.exit(0);
}

await render(() => <App draft={process.env.TAU_DRAFT ?? ""} />, { exitOnCtrlC: false });
