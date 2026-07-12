function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.map((part) => {
			if (!isRecord(part)) return "";
			return typeof part.text === "string" ? part.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function normalizeToolOutput(item: Record<string, unknown>): unknown[] {
	if (item.type !== "function_call_output" || !Array.isArray(item.output)) return [item];
	const images = item.output.filter((part) => isRecord(part) && part.type === "input_image");
	if (images.length === 0) return [item];
	const text = contentText(item.output) || "(tool returned image output)";
	return [
		{ ...item, output: text },
		{
			role: "user",
			content: [
				{ type: "input_text", text: "The previous tool result included image output. Use the attached image." },
				...images,
			],
		},
	];
}

export function rewriteXaiPayload(value: unknown): unknown {
	if (!isRecord(value)) return value;
	const body = { ...value };
	delete body.prompt_cache_retention;
	if (isRecord(body.reasoning)) {
		const effort = body.reasoning.effort;
		body.reasoning =
			typeof effort === "string" && effort !== "none"
				? { effort: effort === "minimal" ? "low" : effort }
				: undefined;
	}
	if (Array.isArray(body.input)) {
		const instructions: string[] = [];
		const input: unknown[] = [];
		for (const raw of body.input) {
			if (!isRecord(raw)) {
				input.push(raw);
				continue;
			}
			if ((raw.role === "developer" || raw.role === "system") && input.length === 0) {
				const text = contentText(raw.content).trim();
				if (text) instructions.push(text);
				continue;
			}
			input.push(...normalizeToolOutput(raw));
		}
		body.input = input;
		if (instructions.length > 0) {
			body.instructions = [typeof body.instructions === "string" ? body.instructions : "", ...instructions]
				.filter(Boolean)
				.join("\n\n");
		}
	}
	return body;
}
