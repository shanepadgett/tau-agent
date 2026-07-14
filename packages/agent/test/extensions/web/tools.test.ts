import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodeSearchTool } from "../../../extensions/web/codesearch.ts";
import { createWebFetchTool } from "../../../extensions/web/webfetch.ts";
import webExtension from "../../../extensions/web/index.ts";
import { clampInteger, normalizeTimeout } from "../../../extensions/web/limits.ts";
import { createWebSearchTool } from "../../../extensions/web/websearch.ts";
import {
	extensionContext,
	type FetchCallInit,
	firstText,
	renderedText,
	renderContext,
	testRowState,
	testTheme,
} from "./helpers.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

function exaResponse(text?: string): Response {
	return new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			result: { content: text === undefined ? [] : [{ type: "text", text }] },
		}),
	);
}

describe("web search tools", () => {
	it("normalizes shared integer and timeout limits", () => {
		expect(clampInteger(undefined, 8, 1, 12)).toBe(8);
		expect(clampInteger(Number.NaN, 8, 1, 12)).toBe(8);
		expect(clampInteger(12.9, 8, 1, 12)).toBe(12);
		expect(clampInteger(-3, 8, 1, 12)).toBe(1);
		expect(normalizeTimeout(undefined, 25)).toBe(25);
		expect(normalizeTimeout(0, 25)).toBe(25);
		expect(normalizeTimeout(800.9, 25)).toBe(600);
	});

	it("sends websearch defaults and clamps supplied values including zero context", async () => {
		const bodies: Array<Record<string, unknown>> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: FetchCallInit) => {
				bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
				return exaResponse("result");
			}),
		);
		const tool = createWebSearchTool(testRowState);
		const defaults = await tool.execute("id", { query: "tau" }, undefined, undefined, extensionContext);
		const clamped = await tool.execute(
			"id",
			{ query: "tau", numResults: 99, livecrawl: "preferred", type: "fast", contextMaxCharacters: 0 },
			undefined,
			undefined,
			extensionContext,
		);
		expect(defaults.details).toEqual({
			query: "tau",
			numResults: 8,
			livecrawl: "fallback",
			type: "auto",
		});
		expect(clamped.details).toMatchObject({ numResults: 12, contextMaxCharacters: 500 });
		expect(bodies[0]).toMatchObject({ params: { name: "web_search_exa", arguments: { numResults: 8 } } });
		expect(bodies[1]).toMatchObject({
			params: {
				name: "web_search_exa",
				arguments: { numResults: 12, livecrawl: "preferred", type: "fast", contextMaxCharacters: 500 },
			},
		});
	});

	it("sends codesearch defaults and clamps token budgets", async () => {
		let body: { params?: unknown } = {};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: FetchCallInit) => {
				body = JSON.parse(String(init?.body)) as { params?: unknown };
				return exaResponse("code");
			}),
		);
		const result = await createCodeSearchTool(testRowState).execute(
			"id",
			{ query: "TypeBox", tokensNum: 30_000.8 },
			undefined,
			undefined,
			extensionContext,
		);
		expect(firstText(result)).toBe("code");
		expect(result.details).toEqual({ query: "TypeBox", tokensNum: 20_000 });
		expect(body.params).toEqual({
			name: "get_code_context_exa",
			arguments: { query: "TypeBox", tokensNum: 20_000 },
		});
	});

	it("uses tool-specific empty messages and truncates provider output", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(exaResponse())
			.mockResolvedValueOnce(exaResponse())
			.mockResolvedValueOnce(exaResponse("x\n".repeat(2100)));
		vi.stubGlobal("fetch", fetchMock);
		const web = createWebSearchTool(testRowState);
		const code = createCodeSearchTool(testRowState);
		expect(firstText(await web.execute("id", { query: "x" }, undefined, undefined, extensionContext))).toBe(
			"No search results found. Try a more specific query.",
		);
		expect(firstText(await code.execute("id", { query: "x" }, undefined, undefined, extensionContext))).toContain(
			"No code context found",
		);
		const truncated = await web.execute("id", { query: "x" }, undefined, undefined, extensionContext);
		expect(firstText(truncated)).toContain("[Output truncated:");
		expect(truncated.details?.truncation?.truncated).toBe(true);
	});

	it("renders compact calls, hides progress, collapses results, expands output, and marks pruned titles", () => {
		const rowState = { ...testRowState, get: () => "pruned" as const };
		const tool = createWebSearchTool(rowState);
		const args = { query: "q".repeat(120), numResults: 20 };
		const renderedCall = renderedText(tool.renderCall?.(args, testTheme, renderContext(args, false)));
		expect(renderedCall).toContain("<warning>*websearch*");
		expect(renderedCall).toContain("…");
		expect(renderedCall).not.toContain("q".repeat(100));

		const partial = { content: [{ type: "text" as const, text: "Searching web..." }], details: undefined };
		expect(
			renderedText(
				tool.renderResult?.(
					partial,
					{ expanded: false, isPartial: true },
					testTheme,
					renderContext(args, false, true),
				),
			),
		).toBe("");
		const result = { content: [{ type: "text" as const, text: "body" }], details: undefined };
		expect(
			renderedText(
				tool.renderResult?.(result, { expanded: false, isPartial: false }, testTheme, renderContext(args, false)),
			),
		).toBe("");
		expect(
			renderedText(
				tool.renderResult?.(result, { expanded: true, isPartial: false }, testTheme, renderContext(args, true)),
			),
		).toContain("<toolOutput>body</toolOutput>");
	});

	it("registers all three tools with one extension", () => {
		const names: string[] = [];
		const events = {
			emit() {},
			on() {
				return () => {};
			},
		};
		const pi = {
			events,
			registerTool(tool: { name: string }) {
				names.push(tool.name);
			},
			on() {},
		} as unknown as ExtensionAPI;
		webExtension(pi);
		expect(names).toEqual(["webfetch", "websearch", "codesearch"]);
	});

	it("keeps specialist guidance in native descriptions", () => {
		for (const tool of [
			createWebFetchTool(testRowState),
			createWebSearchTool(testRowState),
			createCodeSearchTool(testRowState),
		]) {
			expect(tool.promptSnippet).toBeUndefined();
			expect(tool.promptGuidelines).toBeUndefined();
			expect(tool.description.length).toBeGreaterThan(100);
		}
	});
});
