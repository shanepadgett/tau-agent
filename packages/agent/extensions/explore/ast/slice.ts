import type { Decl } from "./ir.ts";

/** UTF-8 file bytes. Prefer the buffer used to hash/parse the file. */
export type SourceBytes = Uint8Array;

export function utf8Slice(bytes: SourceBytes, start: number, end: number): string {
	const lo = Math.max(0, start);
	const hi = Math.min(bytes.length, end);
	if (hi <= lo) return "";
	return Buffer.from(bytes.subarray(lo, hi)).toString("utf8");
}

/** Decl signature: [startByte, signatureEndByte) — no docs, no body. */
export function signatureText(decl: Decl, bytes: SourceBytes): string {
	return utf8Slice(bytes, decl.startByte, decl.signatureEndByte);
}

/** Attached doc comment text, or undefined when none. */
export function docsText(decl: Decl, bytes: SourceBytes): string | undefined {
	if (decl.docStartByte === undefined || decl.docEndByte === undefined) return undefined;
	const text = utf8Slice(bytes, decl.docStartByte, decl.docEndByte);
	return text.length === 0 ? undefined : text;
}

/** Full declaration span [startByte, endByte) — no leading docs. */
export function declarationText(decl: Decl, bytes: SourceBytes): string {
	return utf8Slice(bytes, decl.startByte, decl.endByte);
}

/**
 * Docs (if any) + signature, joined as in source when docs sit immediately above.
 * When docs exist, uses [docStartByte, signatureEndByte); else signature only.
 */
export function signatureWithDocsText(decl: Decl, bytes: SourceBytes): string {
	if (decl.docStartByte === undefined || decl.docEndByte === undefined) {
		return signatureText(decl, bytes);
	}
	return utf8Slice(bytes, decl.docStartByte, decl.signatureEndByte);
}
