const CONVENTIONAL_COMMIT_TYPES = new Set([
	"feat",
	"fix",
	"docs",
	"refactor",
	"test",
	"chore",
	"perf",
	"ci",
	"build",
	"revert",
]);

class CommitMessageValidationError extends Error {}

export function truncAt(text: string, cap: number): string {
	return text.length > cap ? `${text.slice(0, cap)}\n(truncated)` : text;
}

export function stripCodeFence(raw: string): string {
	const text = raw.trim();
	const fenced = text.match(/^```(?:gitcommit|json|text)?\s*\n([\s\S]*?)\n```$/i);
	return fenced?.[1] ? fenced[1].trim() : text;
}

export function cleanMessage(rawMessage: string): string {
	return stripCodeFence(rawMessage)
		.replace(/^commit message:\s*/i, "")
		.trim();
}

export function validateMessage(rawMessage: string): string {
	const message = rawMessage.trim();
	if (!message) throw new CommitMessageValidationError("Commit message is empty.");

	const [header = "", ...bodyLines] = message.split("\n");
	const headerMatch = header.match(/^([a-z]+)(?:\(([a-z0-9]+(?:-[a-z0-9]+)*)\))?(!)?: (.+)$/);
	if (!headerMatch) throw new CommitMessageValidationError("Commit message must use conventional commit format.");

	const [, type, , breakingMark, subject] = headerMatch;
	if (!type || !CONVENTIONAL_COMMIT_TYPES.has(type)) {
		throw new CommitMessageValidationError(`Unsupported commit type: ${type || "missing"}.`);
	}
	if (!subject || subject.length > 100)
		throw new CommitMessageValidationError("Commit subject must be 1-100 characters.");
	if (subject.endsWith(".")) throw new CommitMessageValidationError("Commit subject must not end with a period.");

	const body = bodyLines.join("\n").trim();
	if (!breakingMark && body)
		throw new CommitMessageValidationError("Commit body is only allowed for breaking changes.");
	if (breakingMark && !body.startsWith("BREAKING CHANGE: ")) {
		throw new CommitMessageValidationError("Breaking commits must include a body starting with BREAKING CHANGE:.");
	}
	if (breakingMark && body.split("\n\n").filter((paragraph) => paragraph.trim()).length !== 1) {
		throw new CommitMessageValidationError("Breaking commits must include exactly one BREAKING CHANGE paragraph.");
	}

	return body ? `${header}\n\n${body}` : header;
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
