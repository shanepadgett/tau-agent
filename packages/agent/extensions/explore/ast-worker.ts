import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAstLanguage, type AstLanguage } from "./ast-languages.ts";

export type { AstLanguage } from "./ast-languages.ts";

export type OutlineTarget =
	| { kind: "file"; path: string; language: AstLanguage }
	| { kind: "directory"; path: string }
	| {
			kind: "recursiveDirectory";
			path: string;
			budgets: RecursiveOutlineBudgets;
	  };

export interface RecursiveOutlineBudgets {
	maxFiles: number;
	maxSourceBytes: number;
	maxDepth: number;
	maxElapsedMs: number;
}

const RECURSIVE_OUTLINE_BUDGETS: RecursiveOutlineBudgets = {
	maxFiles: 2000,
	maxSourceBytes: 64 * 1024 * 1024,
	maxDepth: 32,
	maxElapsedMs: 20_000,
};

export interface SourcePosition {
	line: number;
	column: number;
}

export interface SourceRange {
	startByte: number;
	endByte: number;
	start: SourcePosition;
	end: SourcePosition;
}

export interface OutlineEntry {
	role: "item" | "member";
	symbolType: string;
	name: string;
	qualifiedName: string;
	range: SourceRange;
	nameRange: SourceRange;
	receiverRange?: SourceRange;
	bodyRange?: SourceRange;
	signature: string;
	astKind: string;
	certainty: "certain" | "recovered" | "nearRecovery";
	certaintyReason?: string;
	locator?: string;
}

export type SymbolView = "signature" | "signatureWithDocs" | "declaration" | "declarationWithImports";

export interface OutlineItem extends OutlineEntry {
	rowKind: "package" | "import" | "declaration" | "export" | "sideEffect";
	isImport: boolean;
	isExported: boolean;
	members: Array<OutlineEntry & { isPublic: boolean }>;
}

export interface OutlineFileResult {
	path: string;
	language: AstLanguage;
	sourceFingerprint: string;
	byteLength: number;
	lineCount: number;
	diagnostics: { errorNodes: number; missingNodes: number };
	items: OutlineItem[];
}

export interface OutlineTargetResult {
	path: string;
	files: OutlineFileResult[];
	totalByteLength: number;
	totalLineCount: number;
}

export interface RecursiveOutlineDiagnostic {
	relativePath: string;
	language: AstLanguage | undefined;
	code: string;
	message: string;
	sourceFingerprint: string | undefined;
}

export interface RecursiveOutlineSummary {
	discoveredFiles: number;
	supportedFiles: number;
	unsupportedFiles: number;
	emittedFiles: number;
	unreadableFiles: number;
	oversizedFiles: number;
	failedFiles: number;
	parserDegradedFiles: number;
	totalByteLength: number;
	totalLineCount: number;
	fileLimitReached: boolean;
	sourceByteLimitReached: boolean;
	depthLimitReached: boolean;
	elapsedLimitReached: boolean;
}

export interface RecursiveOutlineCallbacks {
	onFile(relativePath: string, file: OutlineFileResult): Promise<void>;
	onDiagnostic(diagnostic: RecursiveOutlineDiagnostic): Promise<void>;
}

export interface SymbolDeclaration {
	locator: string;
	path: string;
	language: AstLanguage;
	sourceFingerprint: string;
	declarationRange: SourceRange;
	diagnostics: string[];
}

export interface SymbolBlock {
	path: string;
	returnedRange: SourceRange;
	declarationIndexes: number[];
	source: string;
}

export interface SymbolBatchResult {
	declarations: SymbolDeclaration[];
	blocks: SymbolBlock[];
}

export type ApiDeclarationKind =
	| "module"
	| "namespace"
	| "package"
	| "class"
	| "method"
	| "property"
	| "field"
	| "constructor"
	| "enum"
	| "interface"
	| "function"
	| "variable"
	| "constant"
	| "object"
	| "enumMember"
	| "struct"
	| "event"
	| "operator"
	| "typeParameter"
	| "heading";

export type ApiQuery =
	| { kind: "exactName"; name: string }
	| { kind: "prefixName"; name: string }
	| { kind: "substringName"; name: string }
	| { kind: "fuzzyName"; name: string; maxCandidates: number; maxWork: number }
	| { kind: "declarationKind"; declarationKind: ApiDeclarationKind }
	| { kind: "documentation"; terms: string[]; maxCandidates: number; maxWork: number };

export type ApiSurfaceFilter = "all" | "public" | "private" | "sourceExport" | "packageSurface";

export interface ApiCandidate {
	locator: string;
	language: AstLanguage;
	sourceFingerprint: string;
	name: string;
	qualifiedName: string;
	symbolType: ApiDeclarationKind;
	signature: string;
	definingFile: string;
	range: SourceRange;
	visibility: "public" | "protected" | "internal" | "packagePrivate" | "filePrivate" | "private" | "unknown";
	sourceExport: "yes" | "no" | "unknown";
	packageSurface: "yes" | "no" | "unknown";
	internalOnly: "yes" | "no" | "unknown";
	reExportChain: string[];
	callerAccess: {
		modulePath: string;
		importStatement: string;
		accessExpression: string;
		form: "direct" | "qualified";
	} | null;
	provenance: "exact" | "inferred" | "ambiguous" | "unsupported";
	certainty: "certain" | "recovered" | "nearRecovery";
	certaintyReason: string | null;
	uncertainty: string | null;
}

export interface ApiDiscoverySummary {
	filesScanned: number;
	declarationsConsidered: number;
	resultsReturned: number;
	resultLimit: number;
	omittedCandidates: number;
	candidateLimitReached: boolean;
	workLimitReached: boolean;
	resolutionDiagnostics: number;
	totalSourceBytes: number;
	fileLimitReached: boolean;
	sourceByteLimitReached: boolean;
	depthLimitReached: boolean;
	elapsedLimitReached: boolean;
}

export interface ApiDiscoveryResult {
	path: string;
	candidates: ApiCandidate[];
	summary: ApiDiscoverySummary;
}

export interface AstSearchBindingValue {
	range: SourceRange;
	preview: string;
	previewTruncated: boolean;
}

export interface AstSearchBinding {
	name: string;
	values: AstSearchBindingValue[];
	valuesTruncated: boolean;
}

export interface AstSearchScope {
	astKind: string;
	range: SourceRange;
	preview: string;
	previewTruncated: boolean;
	locator: string;
}

export interface AstSearchMatch {
	relativePath: string;
	language: AstLanguage;
	sourceFingerprint: string;
	range: SourceRange;
	preview: string;
	previewTruncated: boolean;
	bindings: AstSearchBinding[];
	bindingsTruncated: boolean;
	certainty: "certain" | "recovered" | "nearRecovery";
	certaintyReason?: string;
	locator: string;
	enclosingScope?: AstSearchScope;
}

export interface AstSearchSummary {
	filesDiscovered: number;
	filesFiltered: number;
	languageFilteredFiles: number;
	literalFilteredFiles: number;
	filesRead: number;
	filesParsed: number;
	filesSearched: number;
	unreadableFiles: number;
	oversizedFiles: number;
	failedFiles: number;
	parserDegradedFiles: number;
	sourceBytes: number;
	matchesFound: number;
	matchesReturned: number;
	resultLimit: number;
	resultLimitReached: boolean;
	literalPrefilterApplied: boolean;
	potentialKindPrefilterApplied: boolean;
	diagnosticsOmitted: number;
	fileLimitReached: boolean;
	sourceByteLimitReached: boolean;
	depthLimitReached: boolean;
	elapsedLimitReached: boolean;
}

export interface AstSearchResult {
	path: string;
	language: AstLanguage;
	pattern: string;
	targetSourceFingerprint: string | null;
	matches: AstSearchMatch[];
	diagnostics: Array<{ relativePath: string; code: string; message: string }>;
	summary: AstSearchSummary;
}

export type RelationshipOperation = "references" | "callers" | "callees" | "implementations" | "tests";

export interface EditableScope {
	locator: string;
	language: AstLanguage;
	kind: string;
	qualifiedIdentity: string;
	range: SourceRange;
	bodyRange: SourceRange | null;
	sourceFingerprint: string;
	certainty: "certain" | "recovered" | "nearRecovery";
	certaintyReason: string | null;
}

export interface RelationshipLocation {
	relativePath: string;
	language: AstLanguage;
	sourceFingerprint: string;
	range: SourceRange;
	relationshipKind:
		| "reference"
		| "typeUsage"
		| "caller"
		| "callee"
		| "implementation"
		| "override"
		| "reExport"
		| "test";
	certainty: "exact" | "inferred" | "ambiguous";
	parseCertainty: "certain" | "recovered" | "nearRecovery";
	certaintyReason: string | null;
	classification: "production" | "test" | "generated" | "reExport";
	targetLocator: string;
	targetPath: string;
	targetSourceFingerprint: string;
	candidateLocators: string[];
	candidatePaths: string[];
	candidateSourceFingerprints: string[];
	competingCandidatesOmitted: number;
	actionable: boolean;
	sitePreview: string;
	sitePreviewTruncated: boolean;
	enclosingScope: EditableScope;
}

export interface RelationshipResult {
	path: string;
	operation: RelationshipOperation;
	targetName: string;
	targetLocator: string;
	relationships: RelationshipLocation[];
	summary: {
		filesScanned: number;
		sourceBytes: number;
		parserDegradedFiles: number;
		relationshipsFound: number;
		relationshipsReturned: number;
		resultLimit: number;
		resultLimitReached: boolean;
		ambiguousRelationships: number;
		diagnostics: number;
		fileLimitReached: boolean;
		sourceByteLimitReached: boolean;
		depthLimitReached: boolean;
		elapsedLimitReached: boolean;
	};
}

export type EditOperation =
	| { kind: "replaceDeclaration"; source: string }
	| { kind: "replaceBody"; body: string }
	| { kind: "insertDeclaration"; position: "before" | "after"; source: string }
	| {
			kind: "renameDeclaration";
			newName: string;
			scope: { kind: "file" } | { kind: "repository"; path: string };
			includeInferred: boolean;
	  };

export interface PlannedEdit {
	range: SourceRange;
	replacement: string;
}

export interface EditFilePlan {
	path: string;
	expectedFingerprint: string;
	source: string;
	edits: PlannedEdit[];
}

export interface EditPlanResult {
	files: EditFilePlan[];
	skippedImpacts: Array<{
		path: string;
		range: SourceRange;
		reason: "ambiguous" | "uncertainParse" | "inferredNotApproved";
		candidateLocators: string[];
		candidatePaths: string[];
	}>;
	freshLocators: Array<{
		locator: string;
		path: string;
		name: string;
		sourceFingerprint: string;
	}>;
}

export interface AstClient {
	getGeneration(): number;
	outline(
		target: OutlineTarget,
		includePrivate: boolean,
		includeDocs: boolean,
		names: string[],
		signal: AbortSignal | undefined,
	): Promise<OutlineTargetResult>;
	outlineRecursive(
		path: string,
		includePrivate: boolean,
		includeDocs: boolean,
		names: string[],
		callbacks: RecursiveOutlineCallbacks,
		signal: AbortSignal | undefined,
	): Promise<RecursiveOutlineSummary>;
	symbol(
		locators: string[],
		view: SymbolView,
		contextLines: number,
		signal: AbortSignal | undefined,
	): Promise<SymbolBatchResult>;
	discoverApi(
		path: string,
		query: ApiQuery,
		surface: ApiSurfaceFilter,
		resultLimit: number,
		signal: AbortSignal | undefined,
	): Promise<ApiDiscoveryResult>;
	search(
		path: string,
		language: AstLanguage,
		pattern: string,
		resultLimit: number,
		signal: AbortSignal | undefined,
	): Promise<AstSearchResult>;
	relationships(
		path: string,
		locator: string,
		relationship: RelationshipOperation,
		resultLimit: number,
		signal: AbortSignal | undefined,
	): Promise<RelationshipResult>;
	planEdit(locator: string, edit: EditOperation, signal: AbortSignal | undefined): Promise<EditPlanResult>;
	shutdown(): Promise<void>;
}

type WorkerRequestPayload =
	| { operation: "handshake" }
	| {
			operation: "outline";
			target: OutlineTarget;
			includePrivate: boolean;
			includeDocs: boolean;
			names: string[];
	  }
	| {
			operation: "symbol";
			locators: string[];
			view: SymbolView;
			contextLines: number;
	  }
	| {
			operation: "apiDiscover";
			path: string;
			budgets: RecursiveOutlineBudgets;
			query: ApiQuery;
			surface: ApiSurfaceFilter;
			resultLimit: number;
	  }
	| {
			operation: "astSearch";
			path: string;
			language: AstLanguage;
			budgets: RecursiveOutlineBudgets;
			pattern: string;
			resultLimit: number;
	  }
	| {
			operation: "relationships";
			path: string;
			budgets: RecursiveOutlineBudgets;
			locator: string;
			relationship: RelationshipOperation;
			resultLimit: number;
	  }
	| {
			operation: "planEdit";
			locator: string;
			edit: EditOperation;
			budgets: RecursiveOutlineBudgets;
	  };

interface WorkerResponse {
	requestId: number;
	protocolVersion: number;
	success: boolean;
	result?: Record<string, unknown>;
	error?: { code?: string; message?: string; sourceFingerprint?: string };
}

export class AstWorkerError extends Error {
	readonly code: string;
	readonly sourceFingerprint: string | undefined;

	constructor(code: string, message: string, sourceFingerprint: string | undefined = undefined) {
		super(message);
		this.name = "AstWorkerError";
		this.code = code;
		this.sourceFingerprint = sourceFingerprint;
	}
}

interface PendingUnaryRequest {
	kind: "unary";
	resolve(value: Record<string, unknown>): void;
	reject(error: Error): void;
	removeAbortListener(): void;
}

interface PendingStreamRequest {
	kind: "recursiveOutline";
	started: boolean;
	callbacks: RecursiveOutlineCallbacks;
	resolve(value: RecursiveOutlineSummary): void;
	reject(error: Error): void;
	removeAbortListener(): void;
}

type PendingRequest = PendingUnaryRequest | PendingStreamRequest;

const PROTOCOL_VERSION = 13;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const STDERR_BYTES = 16 * 1024;
const HANDSHAKE_TIMEOUT_MS = 2000;

export type AstWorkerResolution = { command: string } | { error: Error };

export function resolveAstWorkerCommand(
	packageRoot: string,
	platform: NodeJS.Platform,
	arch: string,
): AstWorkerResolution {
	const packagedCommand = join(packageRoot, "native-bin", "darwin-arm64", "tau-ast");
	if (platform === "darwin" && arch === "arm64" && existsSync(packagedCommand)) return { command: packagedCommand };

	const sourceRoot = join(packageRoot, "native", "tau-ast");
	if (existsSync(join(sourceRoot, "Cargo.toml")))
		return {
			command: join(sourceRoot, "target", "release", `tau-ast${platform === "win32" ? ".exe" : ""}`),
		};

	if (platform === "darwin" && arch === "arm64")
		return {
			error: new Error(
				"tau-ast is missing from this @shanepadgett/tau-agent installation. Reinstall the package before using api_discover, ast_search, outline, or symbol.",
			),
		};
	return {
		error: new Error(
			`Packaged AST tools currently require an Apple Silicon Mac (darwin-arm64); this host is ${platform}-${arch}.`,
		),
	};
}

function resolveDefaultAstWorkerCommand(): AstWorkerResolution {
	return resolveAstWorkerCommand(fileURLToPath(new URL("../../", import.meta.url)), process.platform, process.arch);
}

export class AstWorkerClient implements AstClient {
	private readonly command: string | undefined;
	private readonly args: readonly string[];
	private child: ChildProcessWithoutNullStreams | undefined;
	private startPromise: Promise<void> | undefined;
	private pending = new Map<number, PendingRequest>();
	private nextRequestId = 1;
	private incoming = Buffer.alloc(0);
	private readonly drainingChildren = new Set<ChildProcessWithoutNullStreams>();
	private stderr = "";
	private generation = 0;
	private capabilities: readonly AstLanguage[] | undefined;

	constructor(command: string | undefined = undefined, args: readonly string[] = []) {
		this.command = command;
		this.args = args;
	}

	getGeneration(): number {
		return this.generation;
	}

	private resolveCommand(): AstWorkerResolution {
		return this.command ? { command: this.command } : resolveDefaultAstWorkerCommand();
	}

	async supportedLanguages(): Promise<readonly AstLanguage[]> {
		await this.ensureStarted();
		if (!this.capabilities) throw new Error("tau-ast handshake omitted supported languages");
		return this.capabilities;
	}

	async outline(
		target: OutlineTarget,
		includePrivate: boolean,
		includeDocs: boolean,
		names: string[],
		signal: AbortSignal | undefined,
	): Promise<OutlineTargetResult> {
		const result = await this.request({ operation: "outline", target, includePrivate, includeDocs, names }, signal);
		if (result.kind !== "outline") throw new Error("tau-ast returned the wrong result for outline");
		return result as unknown as OutlineTargetResult;
	}

	async outlineRecursive(
		path: string,
		includePrivate: boolean,
		includeDocs: boolean,
		names: string[],
		callbacks: RecursiveOutlineCallbacks,
		signal: AbortSignal | undefined,
	): Promise<RecursiveOutlineSummary> {
		await this.ensureStarted();
		const target: OutlineTarget = {
			kind: "recursiveDirectory",
			path,
			budgets: RECURSIVE_OUTLINE_BUDGETS,
		};
		return this.sendRecursive(
			{ operation: "outline", target, includePrivate, includeDocs, names },
			callbacks,
			signal,
		);
	}

	async symbol(
		locators: string[],
		view: SymbolView,
		contextLines: number,
		signal: AbortSignal | undefined,
	): Promise<SymbolBatchResult> {
		const result = await this.request({ operation: "symbol", locators, view, contextLines }, signal);
		if (result.kind !== "symbol") throw new Error("tau-ast returned the wrong result for symbol");
		return result as unknown as SymbolBatchResult;
	}

	async discoverApi(
		path: string,
		query: ApiQuery,
		surface: ApiSurfaceFilter,
		resultLimit: number,
		signal: AbortSignal | undefined,
	): Promise<ApiDiscoveryResult> {
		const result = await this.request(
			{ operation: "apiDiscover", path, budgets: RECURSIVE_OUTLINE_BUDGETS, query, surface, resultLimit },
			signal,
		);
		if (result.kind !== "apiDiscovery") throw new Error("tau-ast returned the wrong result for API discovery");
		return result as unknown as ApiDiscoveryResult;
	}

	async search(
		path: string,
		language: AstLanguage,
		pattern: string,
		resultLimit: number,
		signal: AbortSignal | undefined,
	): Promise<AstSearchResult> {
		const result = await this.request(
			{ operation: "astSearch", path, language, budgets: RECURSIVE_OUTLINE_BUDGETS, pattern, resultLimit },
			signal,
		);
		if (result.kind !== "astSearch") throw new Error("tau-ast returned the wrong result for ast_search");
		return result as unknown as AstSearchResult;
	}

	async relationships(
		path: string,
		locator: string,
		relationship: RelationshipOperation,
		resultLimit: number,
		signal: AbortSignal | undefined,
	): Promise<RelationshipResult> {
		const result = await this.request(
			{ operation: "relationships", path, budgets: RECURSIVE_OUTLINE_BUDGETS, locator, relationship, resultLimit },
			signal,
		);
		if (result.kind !== "relationships") throw new Error("tau-ast returned the wrong result for relationships");
		return result as unknown as RelationshipResult;
	}

	async planEdit(locator: string, edit: EditOperation, signal: AbortSignal | undefined): Promise<EditPlanResult> {
		const result = await this.request(
			{ operation: "planEdit", locator, edit, budgets: RECURSIVE_OUTLINE_BUDGETS },
			signal,
		);
		if (result.kind !== "editPlan") throw new Error("tau-ast returned the wrong result for edit planning");
		return result as unknown as EditPlanResult;
	}

	async shutdown(): Promise<void> {
		const child = this.child;
		if (!child) return;
		this.child = undefined;
		this.startPromise = undefined;
		this.capabilities = undefined;
		this.rejectPending(new Error("tau-ast worker shut down"));
		child.stdin.end();
		if (child.exitCode !== null) return;
		await Promise.race([
			new Promise<void>((resolve) => child.once("exit", () => resolve())),
			new Promise<void>((resolve) => setTimeout(resolve, 250)),
		]);
		if (child.exitCode === null) child.kill();
	}

	private async request(
		request: WorkerRequestPayload,
		signal: AbortSignal | undefined,
	): Promise<Record<string, unknown>> {
		await this.ensureStarted();
		return this.send(request, signal);
	}

	private async ensureStarted(): Promise<void> {
		if (this.startPromise) {
			await this.startPromise;
			return;
		}
		if (this.child) return;
		this.startPromise ??= this.start().finally(() => {
			this.startPromise = undefined;
		});
		await this.startPromise;
	}

	private async start(): Promise<void> {
		const resolution = this.resolveCommand();
		if ("error" in resolution) throw resolution.error;
		const child = spawn(resolution.command, this.args, {
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.generation += 1;
		this.child = child;
		this.incoming = Buffer.alloc(0);
		this.stderr = "";
		child.stdout.on("data", (chunk: Buffer) => this.receive(child, chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			this.stderr = Buffer.from(`${this.stderr}${chunk.toString("utf8")}`)
				.subarray(-STDERR_BYTES)
				.toString("utf8");
		});
		child.on("error", (error) => this.fail(child, new Error(`Failed to start tau-ast: ${error.message}`)));
		child.on("exit", (code, signal) => {
			if (this.child !== child) return;
			const suffix = this.stderr.trim() ? `: ${this.stderr.trim()}` : "";
			this.fail(child, new Error(`tau-ast exited (${signal ?? code ?? "unknown"})${suffix}`), false);
		});
		const handshakeTimeout = setTimeout(
			() => this.fail(child, new Error(`tau-ast handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms`)),
			HANDSHAKE_TIMEOUT_MS,
		);
		try {
			const result = await this.send({ operation: "handshake" }, undefined);
			if (result.kind !== "handshake") throw new Error("tau-ast handshake returned the wrong result");
			if (!Array.isArray(result.supportedLanguages)) {
				throw new Error("tau-ast handshake omitted supported languages");
			}
			this.capabilities = result.supportedLanguages.filter(isAstLanguage);
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			this.fail(child, failure);
			throw failure;
		} finally {
			clearTimeout(handshakeTimeout);
		}
	}

	private send(request: WorkerRequestPayload, signal: AbortSignal | undefined): Promise<Record<string, unknown>> {
		return this.sendPending(request, signal, (resolve, reject, removeAbortListener) => ({
			kind: "unary",
			resolve,
			reject,
			removeAbortListener,
		}));
	}

	private sendRecursive(
		request: WorkerRequestPayload,
		callbacks: RecursiveOutlineCallbacks,
		signal: AbortSignal | undefined,
	): Promise<RecursiveOutlineSummary> {
		return this.sendPending(request, signal, (resolve, reject, removeAbortListener) => ({
			kind: "recursiveOutline",
			started: false,
			callbacks,
			resolve,
			reject,
			removeAbortListener,
		}));
	}

	private sendPending<T>(
		request: WorkerRequestPayload,
		signal: AbortSignal | undefined,
		createPending: (
			resolve: (value: T) => void,
			reject: (error: Error) => void,
			removeAbortListener: () => void,
		) => PendingRequest,
	): Promise<T> {
		const child = this.child;
		if (!child) return Promise.reject(new Error("tau-ast worker is not running"));
		if (signal?.aborted) return Promise.reject(new Error("tau-ast request cancelled"));
		const requestId = this.nextRequestId++;
		const payload = Buffer.from(JSON.stringify({ ...request, requestId, protocolVersion: PROTOCOL_VERSION }));
		const frame = Buffer.allocUnsafe(payload.length + 4);
		frame.writeUInt32BE(payload.length, 0);
		payload.copy(frame, 4);

		return new Promise<T>((resolve, reject) => {
			const onAbort = (): void => this.fail(child, new Error("tau-ast request cancelled"));
			signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(
				requestId,
				createPending(resolve, reject, () => signal?.removeEventListener("abort", onAbort)),
			);
			child.stdin.write(frame, (error) => {
				if (error) this.fail(child, new Error(`Failed to write tau-ast request: ${error.message}`));
			});
		});
	}

	private receive(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
		if (this.child !== child) return;
		this.incoming = Buffer.concat([this.incoming, chunk]);
		void this.drain(child);
	}

	private async drain(child: ChildProcessWithoutNullStreams): Promise<void> {
		if (this.drainingChildren.has(child) || this.child !== child) return;
		this.drainingChildren.add(child);
		try {
			while (this.child === child && this.incoming.length >= 4) {
				const length = this.incoming.readUInt32BE(0);
				if (length > MAX_FRAME_BYTES) {
					this.fail(child, new Error(`tau-ast response frame exceeds ${MAX_FRAME_BYTES} bytes`));
					return;
				}
				if (this.incoming.length < length + 4) return;
				const payload = this.incoming.subarray(4, length + 4);
				this.incoming = this.incoming.subarray(length + 4);
				let response: WorkerResponse;
				try {
					response = JSON.parse(payload.toString("utf8")) as WorkerResponse;
				} catch (error) {
					this.fail(child, new Error(`tau-ast returned malformed JSON: ${String(error)}`));
					return;
				}
				const pending = this.pending.get(response.requestId);
				if (!pending) {
					this.fail(child, new Error(`tau-ast returned unknown request id ${String(response.requestId)}`));
					return;
				}
				if (response.protocolVersion !== PROTOCOL_VERSION) {
					const error = new Error(`tau-ast response used protocol ${response.protocolVersion}`);
					this.fail(child, error);
					return;
				}
				if (!response.success) {
					this.pending.delete(response.requestId);
					pending.removeAbortListener();
					pending.reject(
						new AstWorkerError(
							response.error?.code ?? "worker_error",
							response.error?.message ?? response.error?.code ?? "tau-ast request failed",
							response.error?.sourceFingerprint,
						),
					);
					continue;
				}
				if (!response.result || typeof response.result !== "object") {
					this.fail(child, new Error("tau-ast response omitted its result"));
					return;
				}
				if (pending.kind === "unary") {
					this.pending.delete(response.requestId);
					pending.removeAbortListener();
					pending.resolve(response.result);
					continue;
				}
				const kind = response.result.kind;
				if (kind === "recursiveStart") {
					if (pending.started || typeof response.result.path !== "string" || !isRecord(response.result.budgets)) {
						this.fail(child, new Error("tau-ast recursive outline returned more than one start frame"));
						return;
					}
					pending.started = true;
					continue;
				}
				if (!pending.started) {
					this.fail(child, new Error("tau-ast recursive outline omitted its start frame"));
					return;
				}
				if (kind === "recursiveFile") {
					const file = parseRecursiveFile(response.result);
					if (!file) {
						this.fail(child, new Error("tau-ast recursive file frame is malformed"));
						return;
					}
					await pending.callbacks.onFile(response.result.relativePath as string, file);
					if (this.child !== child) return;
					continue;
				}
				if (kind === "recursiveDiagnostic") {
					const diagnostic = parseRecursiveDiagnostic(response.result);
					if (!diagnostic) {
						this.fail(child, new Error("tau-ast recursive diagnostic frame is malformed"));
						return;
					}
					await pending.callbacks.onDiagnostic(diagnostic);
					if (this.child !== child) return;
					continue;
				}
				if (kind === "recursiveComplete") {
					const summary = parseRecursiveSummary(response.result);
					if (!summary) {
						this.fail(child, new Error("tau-ast recursive completion frame is malformed"));
						return;
					}
					this.pending.delete(response.requestId);
					pending.removeAbortListener();
					pending.resolve(summary);
					continue;
				}
				this.fail(child, new Error(`tau-ast recursive outline returned unexpected frame ${String(kind)}`));
				return;
			}
		} catch (error) {
			this.fail(child, error instanceof Error ? error : new Error(String(error)));
		} finally {
			this.drainingChildren.delete(child);
		}
	}

	private fail(child: ChildProcessWithoutNullStreams, error: Error, kill = true): void {
		if (this.child !== child) return;
		this.child = undefined;
		this.generation += 1;
		this.incoming = Buffer.alloc(0);
		this.capabilities = undefined;
		this.rejectPending(error);
		if (kill && child.exitCode === null) child.kill();
	}

	private rejectPending(error: Error): void {
		for (const request of this.pending.values()) {
			request.removeAbortListener();
			request.reject(error);
		}
		this.pending.clear();
	}
}

function parseRecursiveFile(result: Record<string, unknown>): OutlineFileResult | undefined {
	if (typeof result.relativePath !== "string" || !isRecord(result.file)) return undefined;
	const file = result.file;
	if (
		typeof file.path !== "string" ||
		!isAstLanguage(file.language) ||
		typeof file.sourceFingerprint !== "string" ||
		!isCount(file.byteLength) ||
		!isCount(file.lineCount) ||
		!isRecord(file.diagnostics) ||
		!isCount(file.diagnostics.errorNodes) ||
		!isCount(file.diagnostics.missingNodes) ||
		!Array.isArray(file.items)
	) {
		return undefined;
	}
	return file as unknown as OutlineFileResult;
}

function parseRecursiveDiagnostic(result: Record<string, unknown>): RecursiveOutlineDiagnostic | undefined {
	if (
		typeof result.relativePath !== "string" ||
		typeof result.code !== "string" ||
		typeof result.message !== "string" ||
		(result.language !== undefined && !isAstLanguage(result.language)) ||
		(result.sourceFingerprint !== undefined && typeof result.sourceFingerprint !== "string")
	) {
		return undefined;
	}
	return {
		relativePath: result.relativePath,
		language: result.language as AstLanguage | undefined,
		code: result.code,
		message: result.message,
		sourceFingerprint: result.sourceFingerprint as string | undefined,
	};
}

function parseRecursiveSummary(result: Record<string, unknown>): RecursiveOutlineSummary | undefined {
	const counts = [
		"discoveredFiles",
		"supportedFiles",
		"unsupportedFiles",
		"emittedFiles",
		"unreadableFiles",
		"oversizedFiles",
		"failedFiles",
		"parserDegradedFiles",
		"totalByteLength",
		"totalLineCount",
	] as const;
	const limits = ["fileLimitReached", "sourceByteLimitReached", "depthLimitReached", "elapsedLimitReached"] as const;
	if (counts.some((name) => !isCount(result[name])) || limits.some((name) => typeof result[name] !== "boolean")) {
		return undefined;
	}
	return result as unknown as RecursiveOutlineSummary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
