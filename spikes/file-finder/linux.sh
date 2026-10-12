#!/usr/bin/env bash
set -euo pipefail
spike="$(dirname "$0")"
spike="$(realpath "$spike")"
mkdir -p "$spike/.work/linux"
docker run --rm --init \
  -v "$spike:/input:ro" \
  -v "$spike/.work/linux:/out" \
  oven/bun:1.4.3 bash -lc '
    set -euo pipefail
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends git time ca-certificates > /out/install.log
    mkdir -p /build /runtime
    cp /input/{package.json,bun.lock,cases.ts,inventory.ts,worker.ts,run.ts,inspect.ts,smoke.ts} /build/
    ln -s /input/corpus /build/corpus
    bun install --cwd /build --frozen-lockfile
    bun build --compile --define FFF_LIBC="\"gnu\"" /build/worker.ts --outfile /runtime/tau
    bun build --compile --define FFF_LIBC="\"gnu\"" /build/inspect.ts --outfile /runtime/tau-inspect
    bun build --compile --define FFF_LIBC="\"gnu\"" /build/smoke.ts --outfile /runtime/tau-smoke
    mkdir -p /build/.work/tmp
    export TMPDIR=/build/.work/tmp
    cd /runtime
    ./tau-inspect /input/corpus/opencode > /out/opencode-inventory.json
    ./tau-inspect /input/corpus/linux > /out/linux-inventory.json
    ./tau-smoke /build/.work/smoke-fixture > /out/smoke.json
    bun /build/run.ts /runtime/tau
    cp /build/.work/linux-results.json /out/results.json
    du -h /runtime/tau > /out/binary-size.txt
  '
