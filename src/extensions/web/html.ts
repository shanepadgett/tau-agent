function decodeCodePoint(value: number): string {
	if (!Number.isFinite(value) || value < 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
		return "";
	}
	return String.fromCodePoint(value);
}

function decodeEntities(text: string): string {
	return text
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&apos;/gi, "'")
		.replace(/&#39;/gi, "'")
		.replace(/&#(\d+);/g, (_match, value: string) => decodeCodePoint(Number.parseInt(value, 10)))
		.replace(/&#x([\da-f]+);/gi, (_match, value: string) => decodeCodePoint(Number.parseInt(value, 16)));
}

function removeNoise(html: string): string {
	return html
		.replace(/<(head|script|style|noscript|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<(head|script|style|noscript|iframe|object|embed)\b[^>]*\/?\s*>/gi, "");
}

function normalize(text: string): string {
	return decodeEntities(text)
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, " ")
		.split("\n")
		.map((line) => line.replace(/[^\S\n]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function htmlToText(html: string): string {
	return normalize(
		removeNoise(html)
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/p\s*>/gi, "\n\n")
			.replace(/<li\b[^>]*>/gi, "\n- ")
			.replace(/<\/li\s*>/gi, "")
			.replace(/<\/(div|section|article|header|footer|main|aside|tr|h[1-6]|ul|ol|table)\s*>/gi, "\n")
			.replace(/<[^>]+>/g, " "),
	);
}

export function htmlToMarkdown(html: string): string {
	return normalize(
		removeNoise(html)
			.replace(
				/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi,
				(_match, level: string, body: string) => `\n${"#".repeat(Number(level))} ${body}\n`,
			)
			.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, "[$2]($1)")
			.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, "**$2**")
			.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, "*$2*")
			.replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, "`$1`")
			.replace(/<li\b[^>]*>/gi, "\n- ")
			.replace(/<\/li\s*>/gi, "")
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/(p|div|section|article|header|footer|main|aside|ul|ol|table|tr)\s*>/gi, "\n")
			.replace(/<[^>]+>/g, " "),
	);
}
