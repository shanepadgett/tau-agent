/**
 * Searches the web through Exa's hosted MCP endpoint, for sessions whose provider has no search of
 * its own. Searches start at least 2 s apart, across every session of the process.
 */

import { Clock, Config, Duration, Effect, Option, Redacted, Ref, Schema, Semaphore } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { SearchRequest } from "./hosted-search.ts";

const EXA_URL = "https://mcp.exa.ai/mcp";
const START_INTERVAL = Duration.seconds(2);
const RESEARCH_CHARACTERS = 10_000;

export class SearchFailed extends Schema.TaggedError<SearchFailed>()("SearchFailed", {
  message: Schema.String,
}) {}

const Reply = Schema.Struct({
  result: Schema.optional(
    Schema.Struct({
      _meta: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      isError: Schema.optional(Schema.Boolean),
      content: Schema.Array(
        Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
      ),
    }),
  ),
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
});

const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(Reply));

/** Makes the search function. Its queue is shared by every call, so make it once per process. */
export const makeExaSearch = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const apiKey = yield* Config.option(Config.Redacted("EXA_API_KEY")).pipe(Effect.orDie);
  const turn = yield* Semaphore.make(1);
  const lastStartMillis = yield* Ref.make(Number.NEGATIVE_INFINITY);

  const waitForTurn = Semaphore.withPermit(turn)(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      const waitMillis =
        (yield* Ref.get(lastStartMillis)) + Duration.toMillis(START_INTERVAL) - now;

      if (waitMillis > 0) yield* Effect.sleep(Duration.millis(waitMillis));
      yield* Ref.set(lastStartMillis, yield* Clock.currentTimeMillis);
    }),
  );

  const request = (search: SearchRequest) =>
    HttpClientRequest.post(EXA_URL).pipe(
      HttpClientRequest.setUrlParams(
        Option.match(apiKey, {
          onNone: () => ({}),
          onSome: (key) => ({ exaApiKey: Redacted.value(key) }),
        }),
      ),
      HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
      HttpClientRequest.bodyJsonUnsafe({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "web_search_exa",
          arguments: {
            query: search.query,
            type: "auto",
            livecrawl: "fallback",
            numResults: search.maxSources,
            contextMaxCharacters: RESEARCH_CHARACTERS,
          },
        },
      }),
    );

  return Effect.fn("exaSearch")(function* (search: SearchRequest) {
    yield* waitForTurn;

    const body = yield* client.execute(request(search)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.mapError(
        (error) => new SearchFailed({ message: `Exa did not answer: ${error.message}` }),
      ),
    );

    return yield* replyText(body);
  });
});

/** Exa answers with plain JSON or with one server-sent event that holds it. */
const replyText = (body: string) => {
  const reply = [body, ...eventData(body)].map((json) => decodeReply(json)).find(Option.isSome);

  if (reply === undefined)
    return Effect.fail(new SearchFailed({ message: "Exa sent a reply Tau cannot read." }));

  const { result, error } = reply.value;

  if (error !== undefined)
    return Effect.fail(new SearchFailed({ message: `Exa failed: ${error.message}` }));

  if (result === undefined)
    return Effect.fail(new SearchFailed({ message: "Exa sent no result." }));

  // A rate-limited reply is a normal result whose text asks for a key; only `_meta` marks it.
  if (result._meta?.["ai.exa/rateLimited"] === true)
    return Effect.fail(
      new SearchFailed({
        message:
          "Exa's free search limit is reached. Set EXA_API_KEY to a key from dashboard.exa.ai.",
      }),
    );

  const text = result.content.flatMap(({ text }) => (text === undefined ? [] : [text])).join("\n");

  if (result.isError === true)
    return Effect.fail(new SearchFailed({ message: `Exa failed: ${text}` }));

  return Effect.succeed(text === "" ? "No results." : text);
};

const eventData = (body: string) =>
  body.split(/\r?\n\r?\n/).flatMap((event) => {
    const json = event
      .split(/\r?\n/)
      .flatMap((line) => (line.startsWith("data:") ? [line.slice("data:".length).trimStart()] : []))
      .join("\n");

    return json === "" ? [] : [json];
  });
