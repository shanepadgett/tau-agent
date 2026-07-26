import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AstWorkerClient, resolveAstWorkerCommand } from "../../../extensions/explore/ast-worker.ts";

const workerScript = String.raw`
let incoming = Buffer.alloc(0);
function frame(response) {
  const payload = Buffer.from(JSON.stringify(response));
  const framed = Buffer.alloc(payload.length + 4);
  framed.writeUInt32BE(payload.length, 0);
  payload.copy(framed, 4);
  return framed;
}
function send(response) {
  process.stdout.write(frame(response));
}
function sendFragmented(response) {
  const framed = frame(response);
  const boundaries = [1, 3, 8, framed.length];
  let start = 0;
  function writeNext() {
    const end = boundaries.shift();
    if (end === undefined) return;
    process.stdout.write(framed.subarray(start, end));
    start = end;
    setTimeout(writeNext, 10);
  }
  writeNext();
}
process.stdin.on("data", (chunk) => {
  incoming = Buffer.concat([incoming, chunk]);
  while (incoming.length >= 4) {
    const length = incoming.readUInt32BE(0);
    if (incoming.length < length + 4) return;
    const request = JSON.parse(incoming.subarray(4, length + 4));
    incoming = incoming.subarray(length + 4);
    if (request.operation === "handshake") {
      send({
        requestId: request.requestId,
        protocolVersion: 12,
        success: true,
        result: { kind: "handshake", supportedLanguages: ["typeScript", "odin"] }
      });
      continue;
    }
    if (request.target?.path === "crash") process.exit(2);
    if (request.target?.path === "hang") continue;
    if (request.operation === "outline") {
      if (request.target.kind === "recursiveDirectory") {
        send({ requestId: request.requestId, protocolVersion: 12, success: true, result: { kind: "recursiveStart", path: request.target.path, budgets: request.target.budgets } });
        send({ requestId: request.requestId, protocolVersion: 12, success: true, result: { kind: "recursiveFile", relativePath: "src/one.ts", file: { path: "/repo/src/one.ts", language: "typeScript", sourceFingerprint: "blake3:test", byteLength: 20, lineCount: 1, diagnostics: { errorNodes: 0, missingNodes: 0 }, items: [] } } });
        send({ requestId: request.requestId, protocolVersion: 12, success: true, result: { kind: "recursiveDiagnostic", relativePath: "src/bad.odin", language: "odin", code: "outlineFailed", message: "bad source" } });
        send({ requestId: request.requestId, protocolVersion: 12, success: true, result: { kind: "recursiveComplete", discoveredFiles: 3, supportedFiles: 2, unsupportedFiles: 1, emittedFiles: 1, unreadableFiles: 0, oversizedFiles: 0, failedFiles: 1, parserDegradedFiles: 0, totalByteLength: 20, totalLineCount: 1, fileLimitReached: false, sourceByteLimitReached: false, depthLimitReached: false, elapsedLimitReached: false } });
        continue;
      }
      const response = {
        requestId: request.requestId,
        protocolVersion: 12,
        success: true,
        result: {
          kind: "outline",
          path: request.target.path,
          files: [],
          totalByteLength: 0,
          totalLineCount: 0
        }
      };
      if (request.target.path === "fragmented.ts") sendFragmented(response);
      else send(response);
      continue;
    }
    if (request.operation === "apiDiscover") {
      send({
        requestId: request.requestId,
        protocolVersion: 12,
        success: true,
        result: {
          kind: "apiDiscovery",
          path: request.path,
          candidates: [{
            locator: "api-locator",
            language: "typeScript",
            sourceFingerprint: "blake3:test",
            name: "blendColor",
            qualifiedName: "blendColor",
            symbolType: "function",
            signature: "export function blendColor(): string",
            definingFile: "/repo/src/color.ts",
            range: { startByte: 0, endByte: 40, start: { line: 0, column: 0 }, end: { line: 0, column: 40 } },
            visibility: "public",
            sourceExport: "yes",
            packageSurface: "yes",
            internalOnly: "no",
            reExportChain: ["mod.ts", "src/color.ts"],
            callerAccess: {
              modulePath: "./mod.ts",
              importStatement: 'import { blendColor } from "./mod.ts";',
              accessExpression: "blendColor",
              form: "direct"
            },
            provenance: "exact",
            certainty: "certain"
          }],
          summary: {
            filesScanned: 2, declarationsConsidered: 4, resultsReturned: 1, resultLimit: request.resultLimit,
            omittedCandidates: 0, candidateLimitReached: false, workLimitReached: false,
            resolutionDiagnostics: 0, totalSourceBytes: 200, fileLimitReached: false,
            sourceByteLimitReached: false, depthLimitReached: false, elapsedLimitReached: false
          }
        }
      });
      continue;
    }
    if (request.operation === "astSearch") {
      send({
        requestId: request.requestId,
        protocolVersion: 12,
        success: true,
        result: {
          kind: "astSearch", path: request.path, language: request.language, pattern: request.pattern,
          targetSourceFingerprint: "blake3:test",
          matches: [], diagnostics: [],
          summary: {
            filesDiscovered: 1, filesFiltered: 0, languageFilteredFiles: 0, literalFilteredFiles: 0,
            filesRead: 1, filesParsed: 1, filesSearched: 1, unreadableFiles: 0, oversizedFiles: 0,
            failedFiles: 0, parserDegradedFiles: 0, sourceBytes: 20, matchesFound: 0, matchesReturned: 0,
            resultLimit: request.resultLimit, resultLimitReached: false, literalPrefilterApplied: true,
            potentialKindPrefilterApplied: true, diagnosticsOmitted: 0, fileLimitReached: false,
            sourceByteLimitReached: false, depthLimitReached: false, elapsedLimitReached: false
          }
        }
      });
      continue;
    }
    if (request.operation === "relationships") {
      send({
        requestId: request.requestId,
        protocolVersion: 12,
        success: true,
        result: {
          kind: "relationships",
          path: request.path,
          operation: request.relationship,
          targetName: "parse",
          targetLocator: request.locator,
          relationships: [],
          summary: {
            filesScanned: 1, sourceBytes: 20, parserDegradedFiles: 0,
            relationshipsFound: 0, relationshipsReturned: 0, resultLimit: request.resultLimit,
            resultLimitReached: false, ambiguousRelationships: 0, diagnostics: 0,
            fileLimitReached: false, sourceByteLimitReached: false,
            depthLimitReached: false, elapsedLimitReached: false
          }
        }
      });
      continue;
    }
    send({
      requestId: request.requestId,
      protocolVersion: 12,
      success: true,
      result: {
        kind: "symbol",
        declarations: [{
          locator: request.locators[0],
          path: "/tmp/file.ts",
          language: "typeScript",
          sourceFingerprint: "blake3:test",
          declarationRange: { startByte: 0, endByte: 1, start: { line: 0, column: 0 }, end: { line: 0, column: 1 } },
          diagnostics: []
        }],
        blocks: [{
          path: "/tmp/file.ts",
          returnedRange: { startByte: 0, endByte: 1, start: { line: 0, column: 0 }, end: { line: 0, column: 1 } },
          declarationIndexes: [0],
          source: "x"
        }]
      }
    });
  }
});
`;

function client(): AstWorkerClient {
	return new AstWorkerClient(process.execPath, ["-e", workerScript]);
}

const workspaces: string[] = [];

async function workspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "tau-ast-resolution-"));
	workspaces.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(workspaces.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AST worker client", () => {
	it("keeps explicit command injection, dispatches framed requests, and shuts down", async () => {
		const worker = client();
		try {
			expect(await worker.supportedLanguages()).toEqual(["typeScript", "odin"]);
			const [typescript, odin] = await Promise.all([
				worker.outline({ kind: "file", path: "one.ts", language: "typeScript" }, false, false, [], undefined),
				worker.outline({ kind: "file", path: "two.odin", language: "odin" }, true, true, ["Circle"], undefined),
			]);
			expect(typescript.path).toBe("one.ts");
			expect(odin.path).toBe("two.odin");
			const discovery = await worker.discoverApi(
				"/repo",
				{ kind: "exactName", name: "blendColor" },
				"packageSurface",
				10,
				undefined,
			);
			expect(discovery.candidates[0]?.callerAccess?.modulePath).toBe("./mod.ts");
			expect(discovery.summary.filesScanned).toBe(2);
			expect((await worker.search("/repo", "typeScript", "call($A)", 10, undefined)).summary.filesSearched).toBe(1);
			expect((await worker.relationships("/repo", "locator", "references", 10, undefined)).operation).toBe(
				"references",
			);
			expect((await worker.symbol(["locator"], "declaration", 2, undefined)).blocks[0]?.source).toBe("x");
		} finally {
			await worker.shutdown();
		}
	});

	it("reassembles response frames split across header and payload chunks", async () => {
		const worker = client();
		try {
			const result = await worker.outline(
				{ kind: "file", path: "fragmented.ts", language: "typeScript" },
				false,
				false,
				[],
				undefined,
			);
			expect(result.path).toBe("fragmented.ts");
		} finally {
			await worker.shutdown();
		}
	});

	it("streams recursive files and diagnostics before resolving the final summary", async () => {
		const worker = client();
		try {
			const events: string[] = [];
			const summary = await worker.outlineRecursive(
				"/repo",
				false,
				false,
				[],
				{
					async onFile(relativePath) {
						events.push(`file:${relativePath}`);
					},
					async onDiagnostic(diagnostic) {
						events.push(`diagnostic:${diagnostic.relativePath}`);
					},
				},
				undefined,
			);
			expect(events).toEqual(["file:src/one.ts", "diagnostic:src/bad.odin"]);
			expect(summary).toMatchObject({
				emittedFiles: 1,
				unsupportedFiles: 1,
				failedFiles: 1,
			});
		} finally {
			await worker.shutdown();
		}
	});

	it("selects the packaged worker on darwin-arm64", async () => {
		const root = await workspace();
		const command = join(root, "native-bin", "darwin-arm64", "tau-ast");
		await mkdir(join(root, "native-bin", "darwin-arm64"), { recursive: true });
		await writeFile(command, "worker");
		expect(resolveAstWorkerCommand(root, "darwin", "arm64")).toEqual({
			command,
		});
	});

	it("falls back to the source Cargo target", async () => {
		const root = await workspace();
		await mkdir(join(root, "native", "tau-ast"), { recursive: true });
		await writeFile(join(root, "native", "tau-ast", "Cargo.toml"), "[package]");
		expect(resolveAstWorkerCommand(root, "linux", "x64")).toEqual({
			command: join(root, "native", "tau-ast", "target", "release", "tau-ast"),
		});
	});

	it("returns deferred installed-package errors for unsupported and missing workers", async () => {
		const root = await workspace();
		const unsupported = resolveAstWorkerCommand(root, "linux", "x64");
		const missing = resolveAstWorkerCommand(root, "darwin", "arm64");
		expect("error" in unsupported ? unsupported.error.message : "").toContain("require an Apple Silicon Mac");
		expect("error" in missing ? missing.error.message : "").toContain("missing from this");
	});

	it("kills a stuck request on cancellation and starts a fresh worker", async () => {
		const worker = client();
		try {
			const controller = new AbortController();
			const request = worker.outline(
				{ kind: "file", path: "hang", language: "typeScript" },
				false,
				false,
				[],
				controller.signal,
			);
			setTimeout(() => controller.abort(), 20);
			await expect(request).rejects.toThrow("cancelled");
			expect(
				(
					await worker.outline(
						{ kind: "file", path: "fresh.ts", language: "typeScript" },
						false,
						false,
						[],
						undefined,
					)
				).path,
			).toBe("fresh.ts");
		} finally {
			await worker.shutdown();
		}
	});

	it("restarts lazily after worker failure", async () => {
		const worker = client();
		try {
			await expect(
				worker.outline({ kind: "file", path: "crash", language: "typeScript" }, false, false, [], undefined),
			).rejects.toThrow("exited");
			expect(
				(
					await worker.outline(
						{ kind: "file", path: "fresh.ts", language: "typeScript" },
						false,
						false,
						[],
						undefined,
					)
				).path,
			).toBe("fresh.ts");
		} finally {
			await worker.shutdown();
		}
	});
});
