// Checks that a compiled binary can start a copy of itself with Bun IPC, as a released Tau will.
// Build: bun build ipc-self.ts --compile --outfile work/ipc-self; run: work/ipc-self
if (process.send === undefined) {
	const child = Bun.spawn([process.execPath, "child"], {
		stdio: ["inherit", "inherit", "inherit"],
		ipc(message) {
			console.log("parent got", JSON.stringify(message));
		},
	});
	child.send({ type: "start-chat", draft: "hello" });
	console.log("child exit", await child.exited);
} else {
	process.on("message", (message) => {
		process.send?.({ type: "echo", argv: process.argv.slice(2), message });
		process.exit(0);
	});
}
