import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSelfCompaction } from "./self-compact.ts";

export default function compactionExtension(pi: ExtensionAPI): void {
	registerSelfCompaction(pi);
}
