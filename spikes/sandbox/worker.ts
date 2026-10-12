// Runs a CPU-bound sandbox script off the main thread. The host interrupts it through a shared flag.
import wasmPath from "quickjs-wasi/quickjs.wasm" with { type: "file" };
import { QuickJS } from "quickjs-wasi";

declare const self: Worker;

self.onmessage = async (event: MessageEvent<{ code: string; flag: Int32Array }>) => {
	const { code, flag } = event.data;
	const wasm = await WebAssembly.compile(await Bun.file(wasmPath).arrayBuffer());
	const vm = await QuickJS.create({ wasm, interruptHandler: () => Atomics.load(flag, 0) === 1 });
	try {
		vm.evalCode(code).dispose();
		self.postMessage("finished");
	} catch (error) {
		self.postMessage(`stopped: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		vm.dispose();
	}
};
