import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAttention } from "./src/attention/index.ts";
import { registerCommit } from "./src/commit/index.ts";
import { registerReference } from "./src/reference/index.ts";

export default function coreExtension(pi: ExtensionAPI): void {
	registerAttention(pi);
	registerCommit(pi);
	registerReference(pi);
}
