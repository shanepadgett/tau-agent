/**
 * Web search and page reading for `run` scripts. Search runs on the small model of the session's
 * provider with the provider's own search tool, and on Exa when the provider has none or it fails.
 */

import { Context, Duration, Effect, Layer, Result } from "effect";
import { HttpClient } from "effect/http";
import { Catalog, type ModelRef } from "../ai/Catalog.ts";
import type { ConversationId } from "../ai/ConversationId.ts";
import { Models } from "../ai/Models.ts";
import { SearchFailed, makeExaSearch } from "./internal/web/exa.ts";
import { FetchFailed, fetchPage, type Page } from "./internal/web/fetch-page.ts";
import {
  type HostedSearchKind,
  hostedSearch,
  type SearchRequest,
  type Source,
} from "./internal/web/hosted-search.ts";

type SearchInput = SearchRequest & { readonly timeout: Duration.Duration };

type FallBack = "timeout" | "failed";

type SearchResult = {
  readonly text: string;
  readonly sources: readonly Source[];
  readonly route: HostedSearchKind | "exa";
  /** Why the provider's own search gave way to Exa. */
  readonly fellBack: FallBack | undefined;
};

/** The provider's search gets this part of the time; Exa gets the rest. */
const HOSTED_SHARE = 0.7;

export class Web extends Context.Service<
  Web,
  {
    /** Searches as the session's model `model` would; `conversationId` keeps the provider's cache. */
    readonly search: (
      model: ModelRef,
      conversationId: ConversationId,
      input: SearchInput,
    ) => Effect.Effect<SearchResult, SearchFailed>;
    readonly fetch: (url: string, timeout: Duration.Duration) => Effect.Effect<Page, FetchFailed>;
  }
>()("tau/core/Web") {
  static readonly layer = Layer.effect(
    Web,
    Effect.gen(function* () {
      const catalog = yield* Catalog;
      const models = yield* Models;
      const client = yield* HttpClient.HttpClient;
      const exaSearch = yield* makeExaSearch;

      const searchHosted = Effect.fn("searchHosted")(function* (
        model: ModelRef,
        conversationId: ConversationId,
        kind: HostedSearchKind,
        input: SearchInput,
      ) {
        const small = yield* models.smallModel(model);
        const languageModel = yield* models.languageModel(small, conversationId);
        return yield* hostedSearch(languageModel, kind, input);
      });

      const searchExa = (input: SearchInput) =>
        exaSearch(input).pipe(Effect.map((text) => exaResult(text, input)));

      const search = Effect.fn("Web.search")(function* (
        model: ModelRef,
        conversationId: ConversationId,
        input: SearchInput,
      ) {
        const kind = yield* catalog.model(model).pipe(
          Effect.map(({ provider }) => provider.hostedSearch),
          Effect.orElseSucceed(() => {}),
        );

        if (kind === undefined) return yield* searchExa(input);

        const hostedTimeout = Duration.times(input.timeout, HOSTED_SHARE);

        const hosted = yield* searchHosted(model, conversationId, kind, input).pipe(
          Effect.tapCause((cause) => Effect.logWarning("Hosted web search failed", cause)),
          Effect.mapError((): FallBack => "failed"),
          Effect.timeoutOrElse({
            duration: hostedTimeout,
            orElse: () => Effect.fail<FallBack>("timeout"),
          }),
          Effect.result,
        );

        if (Result.isSuccess(hosted))
          return { ...hosted.success, route: kind, fellBack: undefined } satisfies SearchResult;

        const exa = yield* searchExa({
          ...input,
          timeout: Duration.subtract(input.timeout, hostedTimeout),
        });

        return { ...exa, fellBack: hosted.failure } satisfies SearchResult;
      });

      return Web.of({
        search: (model, conversationId, input) =>
          search(model, conversationId, input).pipe(
            Effect.timeoutOrElse({
              duration: input.timeout,
              orElse: () => Effect.fail(searchTimedOut(input.timeout)),
            }),
          ),
        fetch: (url, timeout) => fetchWithin(client, url, timeout),
      });
    }),
  );
}

const fetchWithin = (client: HttpClient.HttpClient, url: string, timeout: Duration.Duration) =>
  fetchPage(client, url).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.fail(fetchTimedOut(url, timeout)),
    }),
  );

const exaResult = (text: string, input: SearchInput): SearchResult => ({
  text,
  sources: exaSources(text).slice(0, input.maxSources),
  route: "exa",
  fellBack: undefined,
});

/** Exa's text gives each result a `Title:` line and, later, a `URL:` line. */
const exaSources = (text: string): readonly Source[] => {
  const sources: Source[] = [];
  let title = "";

  for (const line of text.split("\n")) {
    if (line.startsWith("Title:")) title = line.slice("Title:".length).trim();
    if (!line.startsWith("URL:")) continue;

    const url = line.slice("URL:".length).trim();
    sources.push({ url, title: title || url });
    title = "";
  }

  return sources;
};

const searchTimedOut = (timeout: Duration.Duration) =>
  new SearchFailed({
    message: `Web search took longer than ${Duration.toSeconds(timeout)} s. Try again, or give a larger timeoutSeconds.`,
  });

const fetchTimedOut = (url: string, timeout: Duration.Duration) =>
  new FetchFailed({
    message: `Cannot fetch ${url}: no answer in ${Duration.toSeconds(timeout)} s. Try again, or give a larger timeoutSeconds.`,
  });
