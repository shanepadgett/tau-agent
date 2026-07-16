import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { onTauEvent } from "../../shared/events.js";

const DEFAULT_TITLE = "Tau";
const DEFAULT_BODY = "Ready for input";
const COMPACTION_BODY = "Compaction complete";
const BRANCH_SUMMARY_BODY = "Branch summary complete";
const MACOS_SOUND = "/System/Library/Sounds/Submarine.aiff";

function oscText(value: string): string {
	return [...value]
		.map((char) => {
			const code = char.charCodeAt(0);
			return code < 32 || code === 127 || char === ";" ? " " : char;
		})
		.join("")
		.trim();
}

function playMacOSSound(pi: ExtensionAPI): void {
	if (process.platform !== "darwin") return;

	pi.exec("afplay", [MACOS_SOUND], { timeout: 2000 }).catch(() => undefined);
}

export default function attentionExtension(pi: ExtensionAPI): void {
	function notify(data: { title?: string; body?: string }): void {
		const raw: unknown = data;
		const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
		const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : DEFAULT_TITLE;
		const body = typeof record.body === "string" && record.body.trim() ? record.body.trim() : DEFAULT_BODY;
		const oscTitle = oscText(title);
		const oscBody = oscText(body);
		const osc777 = `\x1b]777;notify;${oscTitle};${oscBody}\x07`;

		if (
			existsSync("/tmp/cmux.sock") ||
			process.env.CMUX ||
			process.env.CMUX_SESSION ||
			Object.keys(process.env).some((key) => key.startsWith("CMUX_"))
		) {
			pi.exec("cmux", ["notify", "--title", title, "--body", body], { timeout: 2000 })
				.then((result) => {
					if (result.code !== 0) {
						process.stdout.write(osc777);
						playMacOSSound(pi);
					}
				})
				.catch(() => {
					process.stdout.write(osc777);
					playMacOSSound(pi);
				});
			return;
		}

		if (process.env.KITTY_WINDOW_ID) {
			process.stdout.write(`\x1b]99;i=1:e=1:d=0:p=title;${oscTitle}\x1b\\`);
			process.stdout.write(`\x1b]99;i=1:e=1:d=1:p=body;${oscBody}\x1b\\`);
			return;
		}

		process.stdout.write(osc777);
		playMacOSSound(pi);
	}

	onTauEvent(pi, "attention.agent-blocked", "tau:agent.blocked", notify);

	pi.on("agent_end", (_event, ctx) => {
		if (ctx.mode === "print") return;
		notify({ title: DEFAULT_TITLE, body: DEFAULT_BODY });
	});

	pi.on("session_compact", (_event, ctx) => {
		if (ctx.mode === "print") return;
		notify({ title: DEFAULT_TITLE, body: COMPACTION_BODY });
	});

	pi.on("session_tree", (event, ctx) => {
		if (ctx.mode === "print" || !event.summaryEntry) return;
		notify({ title: DEFAULT_TITLE, body: BRANCH_SUMMARY_BODY });
	});
}
