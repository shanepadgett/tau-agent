import { isAbsolute } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const ATTACHMENTS_TYPE = "tau.reference.attachments";

export interface ReferenceAttachment {
	name: string;
	path: string;
}

export interface ReferenceAttachmentState {
	references: ReferenceAttachment[];
}

export function readReferenceAttachments(entries: readonly SessionEntry[]): ReferenceAttachment[] {
	for (const entry of [...entries].reverse()) {
		if (entry.type !== "custom" || entry.customType !== ATTACHMENTS_TYPE) continue;
		const data: unknown = entry.data;
		if (
			!data ||
			typeof data !== "object" ||
			!("references" in data) ||
			!Array.isArray(data.references) ||
			!data.references.every(
				(ref: unknown): ref is ReferenceAttachment =>
					!!ref &&
					typeof ref === "object" &&
					"name" in ref &&
					typeof ref.name === "string" &&
					ref.name.trim().length > 0 &&
					"path" in ref &&
					typeof ref.path === "string" &&
					isAbsolute(ref.path),
			)
		)
			continue;
		return [...new Map(data.references.map(({ name, path }) => [path, { name, path }])).values()].sort(
			(left, right) => left.path.localeCompare(right.path, "en"),
		);
	}
	return [];
}
