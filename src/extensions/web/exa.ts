const EXA_ENDPOINT = "https://mcp.exa.ai/mcp";

interface FetchResponse {
	ok: boolean;
	status: number;
	text(): Promise<string>;
}

export interface ExaRequest {
	toolName: "web_search_exa" | "get_code_context_exa";
	arguments: Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function extractText(payload: unknown): string | undefined {
	const root = objectValue(payload);
	if (!root) return undefined;
	const error = objectValue(root.error);
	if (error) {
		const message = typeof error.message === "string" ? error.message : JSON.stringify(error);
		throw new Error(`Exa JSON-RPC error: ${message}`);
	}

	const result = objectValue(root.result);
	if (!result || !Array.isArray(result.content)) return undefined;
	const text = result.content
		.map((item) => objectValue(item))
		.filter((item): item is Record<string, unknown> => item !== undefined)
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text as string)
		.join("\n");
	return text.length > 0 ? text : undefined;
}

function parseSse(raw: string): string | undefined {
	for (const event of raw.split(/\r?\n\r?\n/)) {
		const data = event
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /, ""))
			.join("\n");
		if (!data || data === "[DONE]") continue;
		try {
			const text = extractText(JSON.parse(data) as unknown);
			if (text !== undefined) return text;
		} catch (error) {
			if (error instanceof SyntaxError) continue;
			throw error;
		}
	}
	return undefined;
}

export async function callExa(
	request: ExaRequest,
	signal: AbortSignal | undefined,
	timeoutSeconds: number,
): Promise<string | undefined> {
	const timeoutSignal = AbortSignal.timeout(timeoutSeconds * 1000);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const headers: Record<string, string> = {
		accept: "application/json, text/event-stream",
		"content-type": "application/json",
	};
	const apiKey = process.env.EXA_API_KEY?.trim();
	if (apiKey) headers["x-api-key"] = apiKey;

	try {
		const response = (await fetch(EXA_ENDPOINT, {
			method: "POST",
			headers,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: request.toolName, arguments: request.arguments },
			}),
			signal: requestSignal,
		})) as FetchResponse;
		if (!response.ok) {
			throw new Error(`Exa request failed (${response.status}): ${await response.text()}`);
		}

		const raw = await response.text();
		try {
			const direct = extractText(JSON.parse(raw) as unknown);
			if (direct !== undefined) return direct;
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
		}
		return parseSse(raw);
	} catch (error) {
		if (timeoutSignal.aborted && signal?.aborted !== true) {
			throw new DOMException("Exa request timed out", "TimeoutError");
		}
		throw error;
	}
}
