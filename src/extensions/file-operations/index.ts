import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFileOperationsReadTool } from "./read.ts";

export default function fileOperationsExtension(pi: ExtensionAPI): void {
	pi.registerTool(createFileOperationsReadTool(process.cwd()));
}
