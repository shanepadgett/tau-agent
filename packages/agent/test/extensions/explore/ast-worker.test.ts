import { describe, expect, it } from "vitest";
import { AstWorkerClient } from "../../../extensions/explore/ast-worker.ts";

const workerScript = String.raw`
let incoming = Buffer.alloc(0);
function send(response) {
  const payload = Buffer.from(JSON.stringify(response));
  const frame = Buffer.alloc(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  process.stdout.write(frame);
}
process.stdin.on("data", (chunk) => {
  incoming = Buffer.concat([incoming, chunk]);
  while (incoming.length >= 4) {
    const length = incoming.readUInt32BE(0);
    if (incoming.length < length + 4) return;
    const request = JSON.parse(incoming.subarray(4, length + 4));
    incoming = incoming.subarray(length + 4);
    if (request.operation === "handshake") {
      send({ requestId: request.requestId, protocolVersion: 2, success: true, result: { kind: "handshake" } });
      continue;
    }
    if (request.target?.path === "crash") process.exit(2);
    if (request.target?.path === "hang") continue;
    if (request.operation === "outline") {
      send({
        requestId: request.requestId,
        protocolVersion: 2,
        success: true,
        result: {
          kind: "outline",
          path: request.target.path,
          files: [],
          totalByteLength: 0,
          totalLineCount: 0
        }
      });
      continue;
    }
    send({
      requestId: request.requestId,
      protocolVersion: 2,
      success: true,
      result: {
        kind: "symbol",
        declarations: [{
          locator: request.locators[0],
          path: "/tmp/file.ts",
          language: "typeScript",
          sourceFingerprint: "blake3:test",
          declarationRange: { startByte: 0, endByte: 1, start: { line: 0, column: 0 }, end: { line: 0, column: 1 } }
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

describe("AST worker client", () => {
	it("shares startup, dispatches framed requests, and shuts down", async () => {
		const worker = client();
		try {
			const [typescript, odin] = await Promise.all([
				worker.outline({ kind: "file", path: "one.ts", language: "typeScript" }, false, [], undefined),
				worker.outline({ kind: "file", path: "two.odin", language: "odin" }, true, ["Circle"], undefined),
			]);
			expect(typescript.path).toBe("one.ts");
			expect(odin.path).toBe("two.odin");
			expect((await worker.symbol(["locator"], 2, undefined)).blocks[0]?.source).toBe("x");
		} finally {
			await worker.shutdown();
		}
	});

	it("kills a stuck request on cancellation and starts a fresh worker", async () => {
		const worker = client();
		try {
			const controller = new AbortController();
			const request = worker.outline(
				{ kind: "file", path: "hang", language: "typeScript" },
				false,
				[],
				controller.signal,
			);
			setTimeout(() => controller.abort(), 20);
			await expect(request).rejects.toThrow("cancelled");
			expect(
				(await worker.outline({ kind: "file", path: "fresh.ts", language: "typeScript" }, false, [], undefined))
					.path,
			).toBe("fresh.ts");
		} finally {
			await worker.shutdown();
		}
	});

	it("restarts lazily after worker failure", async () => {
		const worker = client();
		try {
			await expect(
				worker.outline({ kind: "file", path: "crash", language: "typeScript" }, false, [], undefined),
			).rejects.toThrow("exited");
			expect(
				(await worker.outline({ kind: "file", path: "fresh.ts", language: "typeScript" }, false, [], undefined))
					.path,
			).toBe("fresh.ts");
		} finally {
			await worker.shutdown();
		}
	});
});
