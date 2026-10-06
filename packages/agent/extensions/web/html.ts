import { DomUtils, Parser, parseDocument } from "htmlparser2";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const NOISE_TAGS = new Set(["head", "script", "style", "noscript", "iframe", "object", "embed"]);
const BLOCK_TAGS = new Set([
	"p",
	"div",
	"section",
	"article",
	"header",
	"footer",
	"main",
	"aside",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"ul",
	"ol",
	"li",
	"table",
	"tr",
	"pre",
	"blockquote",
]);

export function htmlToText(html: string): string {
	let text = "";
	let skipDepth = 0;
	let preDepth = 0;
	const parser = new Parser({
		onopentag(name) {
			if (skipDepth > 0 || NOISE_TAGS.has(name)) {
				skipDepth++;
				return;
			}
			if (BLOCK_TAGS.has(name) || name === "br") text += "\n";
			if (name === "li") text += "- ";
			if (name === "pre") preDepth++;
		},
		ontext(value) {
			if (skipDepth === 0) text += preDepth > 0 ? value : value.replace(/\s+/g, " ");
		},
		onclosetag(name) {
			if (skipDepth > 0) {
				skipDepth--;
				return;
			}
			if (name === "pre") preDepth--;
			if (BLOCK_TAGS.has(name)) text += "\n";
			if (name === "td" || name === "th") text += "\t";
		},
	});
	parser.end(html);
	return text.replace(/^\n+|\n+$/g, "");
}

export function htmlToMarkdown(html: string, finalUrl: string): string {
	const document = parseDocument(html);
	let baseUrl = finalUrl;
	const baseHref = DomUtils.findOne((node) => node.name === "base" && "href" in node.attribs, document.children)
		?.attribs.href;
	if (baseHref) {
		try {
			const base = new URL(baseHref, finalUrl);
			if (base.protocol === "http:" || base.protocol === "https:") baseUrl = base.href;
		} catch {
			// Invalid base elements do not replace the fetched page's URL.
		}
	}
	for (const node of DomUtils.findAll((element) => NOISE_TAGS.has(element.name), document.children)) {
		DomUtils.removeElement(node);
	}
	for (const node of DomUtils.findAll(
		(element) => element.name === "a" || element.name === "img",
		document.children,
	)) {
		const attribute = node.name === "a" ? "href" : "src";
		const value = node.attribs[attribute];
		if (value === undefined) continue;
		try {
			node.attribs[attribute] = new URL(value, baseUrl).href;
		} catch {
			delete node.attribs[attribute];
		}
	}
	const converter = new TurndownService({
		headingStyle: "atx",
		hr: "---",
		bulletListMarker: "-",
		codeBlockStyle: "fenced",
		preformattedCode: true,
		emDelimiter: "*",
	});
	converter.use(gfm);
	converter.addRule("singleLineTableCells", {
		filter: ["th", "td"],
		replacement(content, node) {
			const prefix = node.previousElementSibling === null ? "| " : " ";
			// Physical line breaks end Markdown table rows; retain cell breaks as inline HTML.
			const cell = content
				.trim()
				.replace(/\s*\r?\n+\s*/g, "<br>")
				.replace(/(?<!\\)\|/g, "\\|");
			return `${prefix}${cell} |`;
		},
	});
	return converter.turndown(DomUtils.getOuterHTML(document));
}
