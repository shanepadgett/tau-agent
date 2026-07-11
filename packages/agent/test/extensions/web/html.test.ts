import { describe, expect, it } from "vitest";
import { htmlToMarkdown, htmlToText } from "../../../extensions/web/html.ts";

describe("web HTML conversion", () => {
	it("removes noise and preserves useful text blocks and lists", () => {
		const html = `<head><title>noise</title></head><main><p>First\t line</p><script>bad()</script><ul><li>One</li><li>Two</li></ul><div>Last</div></main>`;
		expect(htmlToText(html)).toBe("First line\n\n- One\n- Two\nLast");
		expect(htmlToText(html)).not.toContain("noise");
		expect(htmlToText(html)).not.toContain("bad");
	});

	it("preserves Markdown headings, links, emphasis, code, and list items", () => {
		const html = `<h2>API</h2><p><a href="/docs"><strong>Read</strong></a> <em>this</em> <code>x()</code></p><ol><li>Run</li></ol>`;
		expect(htmlToMarkdown(html)).toBe("## API\n[**Read**](/docs) *this* `x()`\n\n- Run");
	});

	it("decodes named and numeric entities and drops invalid code points", () => {
		const html = `<p>&lt;x&gt; &amp; &quot;q&quot; &apos;a&apos; &#65; &#x1F600; &#xD800; &#99999999;</p>`;
		expect(htmlToText(html)).toBe(`<x> & "q" 'a' A 😀`);
		expect(htmlToMarkdown(html)).toBe(`<x> & "q" 'a' A 😀`);
	});

	it("normalizes carriage returns, horizontal whitespace, and blank lines", () => {
		expect(htmlToText("<p>a\r\n\t b</p><div>c</div><div></div><div>d</div>")).toBe("a\nb\n\nc\n\nd");
	});
});
