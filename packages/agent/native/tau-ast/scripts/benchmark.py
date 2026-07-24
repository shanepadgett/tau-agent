#!/usr/bin/env python3

import json
import statistics
import struct
import subprocess
import sys
import time
from pathlib import Path

ITERATIONS = 20
ROOT = Path(__file__).resolve().parents[5]
WORKER = ROOT / "packages/agent/native/tau-ast/target/release/tau-ast"


def frame(request: dict[str, object]) -> bytes:
    payload = json.dumps(request, separators=(",", ":")).encode()
    return struct.pack(">I", len(payload)) + payload


def read_response(stdout) -> dict[str, object]:
    length_bytes = stdout.read(4)
    if len(length_bytes) != 4:
        raise RuntimeError("worker closed before returning a frame")
    length = struct.unpack(">I", length_bytes)[0]
    response = json.loads(stdout.read(length))
    if not response["success"]:
        raise RuntimeError(response["error"])
    return response


def request(request_id: int, path: Path, language: str) -> dict[str, object]:
    return {
        "operation": "outline",
        "requestId": request_id,
        "protocolVersion": 1,
        "path": str(path),
        "language": language,
    }


def cold_samples(path: Path, language: str) -> list[float]:
    samples = []
    for iteration in range(ITERATIONS):
        wire = frame(
            {"operation": "handshake", "requestId": 1, "protocolVersion": 1}
        ) + frame(request(2, path, language))
        started = time.perf_counter()
        process = subprocess.run(
            [WORKER], input=wire, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True
        )
        samples.append((time.perf_counter() - started) * 1000)
        if process.stderr:
            raise RuntimeError(process.stderr.decode())
    return samples


def warm_samples(path: Path, language: str) -> tuple[list[float], dict[str, object]]:
    process = subprocess.Popen(
        [WORKER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    if process.stdin is None or process.stdout is None:
        raise RuntimeError("worker pipes were not created")
    process.stdin.write(
        frame({"operation": "handshake", "requestId": 1, "protocolVersion": 1})
    )
    process.stdin.flush()
    read_response(process.stdout)

    process.stdin.write(frame(request(2, path, language)))
    process.stdin.flush()
    result = read_response(process.stdout)

    samples = []
    for iteration in range(ITERATIONS):
        started = time.perf_counter()
        process.stdin.write(frame(request(iteration + 3, path, language)))
        process.stdin.flush()
        result = read_response(process.stdout)
        samples.append((time.perf_counter() - started) * 1000)

    process.stdin.close()
    return_code = process.wait(timeout=10)
    if return_code != 0:
        stderr = process.stderr.read().decode() if process.stderr else ""
        raise RuntimeError(f"worker exited {return_code}: {stderr}")
    return samples, result


def summary(samples: list[float]) -> dict[str, float]:
    ordered = sorted(samples)
    return {
        "minimumMs": round(ordered[0], 3),
        "medianMs": round(statistics.median(ordered), 3),
        "p95Ms": round(ordered[int(len(ordered) * 0.95) - 1], 3),
    }


def benchmark(path: Path, language: str) -> dict[str, object]:
    cold = cold_samples(path, language)
    warm, response = warm_samples(path, language)
    result = response["result"]
    return {
        "path": str(path),
        "language": language,
        "bytes": result["byteLength"],
        "items": len(result["items"]),
        "diagnostics": result["diagnostics"],
        "cold": summary(cold),
        "warm": summary(warm),
    }


if len(sys.argv) != 3:
    raise SystemExit("usage: benchmark.py TYPESCRIPT_PATH ODIN_PATH")

typescript_path = (ROOT / sys.argv[1]).resolve()
odin_path = (ROOT / sys.argv[2]).resolve()
print(
    json.dumps(
        {
            "iterations": ITERATIONS,
            "results": [
                benchmark(typescript_path, "typeScript"),
                benchmark(odin_path, "odin"),
            ],
        },
        indent=2,
    )
)
