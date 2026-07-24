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
      send({ requestId: request.requestId, protocolVersion: 1, success: true, result: { kind: "handshake" } });
      continue;
    }
    if (request.path === "crash") process.exit(2);
    if (request.path === "hang") continue;
    if (request.operation === "outline") {
      send({
        requestId: request.requestId,
        protocolVersion: 1,
        success: true,
        result: {
          kind: "outline",
          path: request.path,
          language: request.language,
          sourceFingerprint: "blake3:test",
          byteLength: 0,
          lineCount: 0,
          diagnostics: { errorNodes: 0, missingNodes: 0 },
          items: []
        }
      });
      continue;
    }
    send({
      requestId: request.requestId,
      protocolVersion: 1,
      success: true,
      result: {
        kind: "symbol",
        path: "/tmp/file.ts",
        language: "typeScript",
        sourceFingerprint: "blake3:test",
        range: { startByte: 0, endByte: 1, start: { line: 0, column: 0 }, end: { line: 0, column: 1 } },
        source: "x"
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
				worker.outline("one.ts", "typeScript", undefined),
				worker.outline("two.odin", "odin", undefined),
			]);
			expect(typescript.path).toBe("one.ts");
			expect(odin.language).toBe("odin");
			expect((await worker.symbol("locator", undefined)).source).toBe("x");
		} finally {
			await worker.shutdown();
		}
	});

	it("kills a stuck request on cancellation and starts a fresh worker", async () => {
		const worker = client();
		try {
			const controller = new AbortController();
			const request = worker.outline("hang", "typeScript", controller.signal);
			setTimeout(() => controller.abort(), 20);
			await expect(request).rejects.toThrow("cancelled");
			expect((await worker.outline("fresh.ts", "typeScript", undefined)).path).toBe("fresh.ts");
		} finally {
			await worker.shutdown();
		}
	});

	it("restarts lazily after worker failure", async () => {
		const worker = client();
		try {
			await expect(worker.outline("crash", "typeScript", undefined)).rejects.toThrow("exited");
			expect((await worker.outline("fresh.ts", "typeScript", undefined)).path).toBe("fresh.ts");
		} finally {
			await worker.shutdown();
		}
	});
});
