import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import {
	TemporaryOutputError,
	type TemporaryOutputStore,
	type TemporaryOutputWriter,
} from "./temporary-output-store.ts";

export type BoundedTextStrategy = "head" | "tail" | "completeBlocks";

export interface BoundedTextOverflowDetails {
	strategy: BoundedTextStrategy;
	truncated: boolean;
	shownLines: number;
	totalLines: number;
	shownBytes: number;
	totalBytes: number;
	fullOutputComplete: boolean;
	temporaryPath: string | undefined;
	failure: "quota" | "write" | undefined;
}

export interface BoundedTextResult {
	content: string;
	overflow: BoundedTextOverflowDetails;
	visibleUnitIds: string[];
}

export function truncateBoundedHead(content: string): ReturnType<typeof truncateHead> {
	return truncateHead(content, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
}

interface VisibleBlock {
	id: string | undefined;
	label: string;
	text: string;
}

export class BoundedTextResultBuilder {
	private readonly store: TemporaryOutputStore;
	private readonly strategy: BoundedTextStrategy;
	private snapshot = "";
	private blocks: VisibleBlock[] = [];
	private requiredBlocks: VisibleBlock[] = [];
	private totalBytes = 0;
	private newlineCount = 0;
	private hasContent = false;
	private endsWithNewline = false;
	private overflowed = false;
	private modelClosed = false;
	private oversizedBlockLabel: string | undefined;
	private output: TemporaryOutputWriter | undefined;
	private persistenceFailure: "quota" | "write" | undefined;
	private finished = false;

	constructor(store: TemporaryOutputStore, strategy: BoundedTextStrategy) {
		this.store = store;
		this.strategy = strategy;
	}

	// fallow-ignore-next-line unused-class-member -- head/tail strategy API; callers use completeBlocks today
	async append(text: string): Promise<void> {
		if (this.strategy === "completeBlocks") throw new Error("Complete-block results require appendBlock");
		this.requireOpen();
		this.count(text);
		if (!this.overflowed) {
			const candidate = `${this.snapshot}${text}`;
			const truncation = this.strategy === "head" ? truncateHead(candidate) : truncateTail(candidate);
			this.snapshot = truncation.content;
			if (!truncation.truncated) return;
			this.overflowed = true;
			await this.persist(candidate);
			return;
		}
		if (this.strategy === "tail") this.snapshot = truncateTail(`${this.snapshot}${text}`).content;
		await this.persist(text);
	}

	async appendBlock(id: string | undefined, label: string, text: string): Promise<void> {
		if (this.strategy !== "completeBlocks") throw new Error("Text results require append");
		this.requireOpen();
		const prefix = this.hasContent ? "\n\n" : "";
		const chunk = `${prefix}${text}`;
		this.count(chunk);

		if (!this.modelClosed) {
			const candidate = `${this.snapshot}${chunk}`;
			if (!truncateHead(candidate).truncated) {
				this.snapshot = candidate;
				this.blocks.push({ id, label, text });
				return;
			}
			this.modelClosed = true;
			this.overflowed = true;
			if (this.blocks.length === 0) this.oversizedBlockLabel = label.replaceAll(/[\r\n]/g, " ");
			await this.persist(candidate);
			return;
		}
		await this.persist(chunk);
	}

	async appendRequiredBlock(label: string, text: string): Promise<void> {
		if (this.strategy !== "completeBlocks") throw new Error("Required blocks need complete-block retention");
		this.requireOpen();
		const block = { id: undefined, label, text };
		this.requiredBlocks.push(block);
		const prefix = this.hasContent ? "\n\n" : "";
		const chunk = `${prefix}${text}`;
		this.count(chunk);
		if (!this.overflowed) {
			const candidate = `${this.snapshot}${chunk}`;
			if (!truncateHead(candidate).truncated) {
				this.snapshot = candidate;
				return;
			}
			this.overflowed = true;
			this.modelClosed = true;
			await this.persist(candidate);
			return;
		}
		await this.persist(chunk);
	}

	async finish(): Promise<BoundedTextResult> {
		this.requireOpen();
		this.finished = true;
		let temporaryPath: string | undefined;
		if (this.output) {
			try {
				temporaryPath = await this.output.finish();
			} catch (error) {
				this.persistenceFailure = error instanceof TemporaryOutputError ? error.code : "write";
			}
			this.output = undefined;
		}

		const totalLines = lineCount(this.hasContent, this.newlineCount, this.endsWithNewline);
		if (!this.overflowed) {
			return {
				content: this.snapshot,
				overflow: {
					strategy: this.strategy,
					truncated: false,
					shownLines: totalLines,
					totalLines,
					shownBytes: this.totalBytes,
					totalBytes: this.totalBytes,
					fullOutputComplete: true,
					temporaryPath: undefined,
					failure: undefined,
				},
				visibleUnitIds: this.blocks.flatMap((block) => (block.id === undefined ? [] : [block.id])),
			};
		}

		if (this.strategy === "completeBlocks") {
			return this.finishBlocks(totalLines, temporaryPath);
		}
		return this.finishText(totalLines, temporaryPath);
	}

	async abort(): Promise<void> {
		this.finished = true;
		const output = this.output;
		this.output = undefined;
		if (output) await output.abort();
	}

	private finishBlocks(totalLines: number, temporaryPath: string | undefined): BoundedTextResult {
		const blocks = [...this.blocks];
		const required = this.requiredBlocks.map((block) => block.text).join("\n\n");
		let retained = [...blocks.map((block) => block.text), required].filter(Boolean).join("\n\n");
		let shownBytes = Buffer.byteLength(retained);
		let shownLines = textLineCount(retained);
		let notice = this.notice(shownLines, shownBytes, totalLines, temporaryPath);
		const oversized = this.oversizedBlockLabel
			? `[File block omitted because it exceeds the model-output budget: ${this.oversizedBlockLabel}. Run a non-recursive outline for that file.]`
			: "";
		while (blocks.length > 0 && truncateHead([retained, oversized, notice].filter(Boolean).join("\n\n")).truncated) {
			blocks.pop();
			retained = [...blocks.map((block) => block.text), required].filter(Boolean).join("\n\n");
			shownBytes = Buffer.byteLength(retained);
			shownLines = textLineCount(retained);
			notice = this.notice(shownLines, shownBytes, totalLines, temporaryPath);
		}
		let content = [retained, oversized, notice].filter(Boolean).join("\n\n");
		if (truncateHead(content).truncated) content = truncateHead(content).content;
		return {
			content,
			overflow: this.overflowDetails(shownLines, shownBytes, totalLines, temporaryPath),
			visibleUnitIds: blocks.flatMap((block) => (block.id === undefined ? [] : [block.id])),
		};
	}

	private finishText(totalLines: number, temporaryPath: string | undefined): BoundedTextResult {
		let retained = this.snapshot;
		let shownBytes = Buffer.byteLength(retained);
		let shownLines = textLineCount(retained);
		let notice = this.notice(shownLines, shownBytes, totalLines, temporaryPath);
		for (let iteration = 0; iteration < 3; iteration += 1) {
			const noticeLines = textLineCount(notice) + 1;
			const noticeBytes = Buffer.byteLength(notice) + 2;
			const options = {
				maxLines: Math.max(0, DEFAULT_MAX_LINES - noticeLines),
				maxBytes: Math.max(0, DEFAULT_MAX_BYTES - noticeBytes),
			};
			retained = (
				this.strategy === "head" ? truncateHead(this.snapshot, options) : truncateTail(this.snapshot, options)
			).content;
			shownBytes = Buffer.byteLength(retained);
			shownLines = textLineCount(retained);
			notice = this.notice(shownLines, shownBytes, totalLines, temporaryPath);
		}
		return {
			content: [retained, notice].filter(Boolean).join("\n\n"),
			overflow: this.overflowDetails(shownLines, shownBytes, totalLines, temporaryPath),
			visibleUnitIds: [],
		};
	}

	private overflowDetails(
		shownLines: number,
		shownBytes: number,
		totalLines: number,
		temporaryPath: string | undefined,
	): BoundedTextOverflowDetails {
		return {
			strategy: this.strategy,
			truncated: true,
			shownLines,
			totalLines,
			shownBytes,
			totalBytes: this.totalBytes,
			fullOutputComplete: temporaryPath !== undefined && this.persistenceFailure === undefined,
			temporaryPath,
			failure: this.persistenceFailure,
		};
	}

	private notice(
		shownLines: number,
		shownBytes: number,
		totalLines: number,
		temporaryPath: string | undefined,
	): string {
		return formatBoundedTextOverflow({
			strategy: this.strategy,
			truncated: true,
			shownLines,
			totalLines,
			shownBytes,
			totalBytes: this.totalBytes,
			fullOutputComplete: temporaryPath !== undefined && this.persistenceFailure === undefined,
			temporaryPath,
			failure: this.persistenceFailure,
		});
	}

	private count(text: string): void {
		if (text.length === 0) return;
		this.totalBytes += Buffer.byteLength(text);
		this.newlineCount += text.split("\n").length - 1;
		this.hasContent = true;
		this.endsWithNewline = text.endsWith("\n");
	}

	private async persist(text: string): Promise<void> {
		if (this.persistenceFailure) return;
		try {
			this.output ??= await this.store.createOutput();
			await this.output.write(text);
		} catch (error) {
			this.persistenceFailure = error instanceof TemporaryOutputError ? error.code : "write";
			const output = this.output;
			this.output = undefined;
			if (output) await output.abort();
		}
	}

	private requireOpen(): void {
		if (this.finished) throw new Error("Bounded text result is already finished");
	}
}

function formatBoundedTextOverflow(details: BoundedTextOverflowDetails): string {
	const sizes = `${details.shownLines} of ${details.totalLines} lines (${formatSize(details.shownBytes)} of ${formatSize(details.totalBytes)})`;
	if (details.fullOutputComplete && details.temporaryPath) {
		return `[Output truncated: showing ${sizes}. Complete output: ${details.temporaryPath}\nTemporary output is valid only for the active session. Use targeted grep or ranged read; reading the whole file will hit the same output limits.]`;
	}
	const reason = details.failure === "quota" ? "disk quota exceeded" : "temporary-file write failed";
	return `[Output truncated: showing ${sizes}. Complete temporary output unavailable: ${reason}.]`;
}

function textLineCount(text: string): number {
	return lineCount(text.length > 0, text.split("\n").length - 1, text.endsWith("\n"));
}

function lineCount(hasContent: boolean, newlineCount: number, endsWithNewline: boolean): number {
	return hasContent ? newlineCount + (endsWithNewline ? 0 : 1) : 0;
}
