import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAttention } from "./src/attention/index.ts";
import { registerCommit } from "./src/commit/index.ts";
import { registerReference } from "./src/reference/index.ts";
import { registerSoul } from "./src/soul/index.ts";
import { registerTau } from "./src/tau/index.ts";

export default function coreExtension(pi: ExtensionAPI): void {
	registerTau(pi);
	registerSoul(pi);
	registerAttention(pi);
	registerCommit(pi);
	registerReference(pi);
}
