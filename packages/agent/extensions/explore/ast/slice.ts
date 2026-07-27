import type { Decl } from "./ir.ts";

// All offsets are UTF-16 code units into the decoded source string (ir.ts).

/** Decl signature: [startOffset, signatureEndOffset) — no docs, no body. */
export function signatureText(decl: Decl, source: string): string {
	return source.slice(decl.startOffset, decl.signatureEndOffset);
}

/** Attached doc comment text, or undefined when none. */
export function docsText(decl: Decl, source: string): string | undefined {
	if (decl.docStartOffset === undefined || decl.docEndOffset === undefined) return undefined;
	const text = source.slice(decl.docStartOffset, decl.docEndOffset);
	return text.length === 0 ? undefined : text;
}

/** Full declaration span [startOffset, endOffset) — no leading docs. */
export function declarationText(decl: Decl, source: string): string {
	return source.slice(decl.startOffset, decl.endOffset);
}

/**
 * Docs (if any) + signature, joined as in source when docs sit immediately above.
 * When docs exist, uses [docStartOffset, signatureEndOffset); else signature only.
 */
export function signatureWithDocsText(decl: Decl, source: string): string {
	if (decl.docStartOffset === undefined || decl.docEndOffset === undefined) {
		return signatureText(decl, source);
	}
	return source.slice(decl.docStartOffset, decl.signatureEndOffset);
}
