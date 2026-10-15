/**
 * Reads a web page for a `run` script. HTML becomes plain text with its links kept; other text
 * types come back as they are.
 */

import { Effect, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

const MAX_BYTES = 5_242_880; // 5 MB

// Some sites refuse requests that do not look like a browser.
const BROWSER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

export class FetchFailed extends Schema.TaggedError<FetchFailed>()("FetchFailed", {
  message: Schema.String,
}) {}

export type Page = {
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly text: string;
};

export const fetchPage = Effect.fn("fetchPage")(function* (
  client: HttpClient.HttpClient,
  url: string,
) {
  const failed = (problem: string) =>
    new FetchFailed({ message: `Cannot fetch ${url}: ${problem}` });

  const response = yield* client
    .execute(
      HttpClientRequest.get(url, {
        headers: {
          "user-agent": BROWSER_AGENT,
          accept: "text/html, application/xhtml+xml, text/plain;q=0.9, */*;q=0.5",
        },
      }),
    )
    .pipe(Effect.mapError((error) => failed(error.message)));

  const contentType = response.headers["content-type"] ?? "";
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";

  if (!isText(mediaType))
    return yield* failed(
      `it is ${mediaType || "of no stated type"}, not text. Download it with sh instead.`,
    );

  const bytes = yield* Stream.runFoldEffect(
    response.stream.pipe(Stream.mapError((error) => failed(error.message))),
    () => new Uint8Array(0),
    (read, chunk) =>
      read.length + chunk.length > MAX_BYTES
        ? Effect.fail(failed("the page is larger than 5 MB. Download it with sh instead."))
        : Effect.succeed(joinBytes(read, chunk)),
  );

  const body = new TextDecoder().decode(bytes);
  const isHtml = mediaType === "text/html" || mediaType === "application/xhtml+xml";

  return {
    url: response.request.url,
    status: response.status,
    contentType,
    text: isHtml ? htmlText(body) : body,
  } satisfies Page;
});

const isText = (mediaType: string) =>
  mediaType === "" ||
  mediaType.startsWith("text/") ||
  ["json", "xml", "javascript"].some(
    (kind) => mediaType.endsWith(kind) || mediaType.endsWith(`+${kind}`),
  );

const joinBytes = (read: Uint8Array, chunk: Uint8Array) => {
  const joined = new Uint8Array(read.length + chunk.length);
  joined.set(read);
  joined.set(chunk, read.length);
  return joined;
};

const SKIPPED = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "head",
  "iframe",
  "canvas",
]);

const BLOCKS = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "header",
  "footer",
  "nav",
  "aside",
  "li",
  "ul",
  "ol",
  "table",
  "tr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "pre",
  "blockquote",
  "dt",
  "dd",
  "figure",
]);

/**
 * Only agents read the result, so it keeps the words, line breaks and link targets, and drops
 * styling. Bun's HTMLRewriter streams elements and text in document order.
 */
const htmlText = (html: string) => {
  const parts: string[] = [];
  let skippedDepth = 0;

  new HTMLRewriter()
    .on("*", {
      element(element) {
        const tag = element.tagName;

        if (tag === "br" || tag === "hr") {
          parts.push("\n");
          return;
        }

        if (SKIPPED.has(tag)) {
          skippedDepth += 1;

          element.onEndTag(() => {
            skippedDepth -= 1;
          });

          return;
        }

        if (BLOCKS.has(tag)) {
          parts.push("\n");

          element.onEndTag(() => {
            parts.push("\n");
          });

          return;
        }

        const href = tag === "a" ? element.getAttribute("href") : null;

        if (href !== null && /^https?:/.test(href))
          element.onEndTag(() => {
            if (skippedDepth === 0) parts.push(` (${href})`);
          });
      },
    })
    .onDocument({
      text(chunk) {
        if (skippedDepth === 0) parts.push(chunk.text);
      },
    })
    .transform(html);

  return tidy(decodeEntities(parts.join("")));
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const decodeEntities = (text: string) =>
  text.replaceAll(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (!name.startsWith("#")) return NAMED_ENTITIES[name.toLowerCase()] ?? entity;

    const isHex = name[1] === "x" || name[1] === "X";
    const codePoint = isHex ? hexNumber(name.slice(2)) : Number(name.slice(1));
    return codePoint <= MAX_CODE_POINT ? String.fromCodePoint(codePoint) : entity;
  });

const MAX_CODE_POINT = 0x10_ffff;

const hexNumber = (digits: string) => Number(`0x${digits}`);

const tidy = (text: string) =>
  text
    .split("\n")
    .map((line) => line.replaceAll(/[ \t\f\r]+/g, " ").trim())
    .join("\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
