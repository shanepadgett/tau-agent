#!/usr/bin/env bash
set -euo pipefail
spike="$(realpath "$(dirname "$0")")"
mkdir -p "$spike/.work/ranking-linux"
docker run --rm --init \
  -v "$spike:/input:ro" \
  -v "$spike/.work/ranking-linux:/out" \
  oven/bun:1.4.3 bash -lc '
    set -euo pipefail
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends git time ca-certificates curl build-essential pkg-config > /out/install.log
    curl -fsSL https://sh.rustup.rs -o /build-rustup.sh
    sh /build-rustup.sh -y --default-toolchain 1.99.0 --profile minimal --no-modify-path > /out/rust-install.log 2>&1
    export PATH="$HOME/.cargo/bin:$PATH"
    mkdir -p /build /runtime /source /out/tmp
    git -C /input/.work/fff-source archive HEAD | tar -x -C /source
    cp /input/{package.json,bun.lock,cases.ts,inventory.ts,worker.ts,ranking-probe.ts,smoke.ts,build-native.ts} /build/
    bun install --cwd /build --frozen-lockfile
    export TMPDIR=/out/tmp
    cd /runtime
    for variant in baseline patched; do
      if [ "$variant" = patched ]; then
        git -C /source apply /input/native-ranking.patch
        cargo test --manifest-path /source/Cargo.toml --locked -p fff-search --lib score:: > /out/tests.log 2>&1
      fi
      cargo build --manifest-path /source/Cargo.toml --locked --release -p fff-c > "/out/build-$variant.log" 2>&1
      for entry in ranking-probe worker smoke; do
        bun /build/build-native.ts "/build/$entry.ts" /source/target/release/libfff_c.so "/runtime/$entry-$variant"
      done
      for dataset in opencode linux; do
        for trial in 1 2 3 4 5; do
          "/runtime/ranking-probe-$variant" "$dataset" "/input/corpus/$dataset" > "/out/$variant-$dataset-$trial.json"
        done
        for trial in 1 2 3; do
          /usr/bin/time -v -o "/out/perf-$variant-$dataset-$trial.time" "/runtime/worker-$variant" fff "$dataset" "/input/corpus/$dataset" > "/out/perf-$variant-$dataset-$trial.json"
        done
      done
      "/runtime/smoke-$variant" "/out/smoke-$variant-fixture" > "/out/smoke-$variant.json"
    done
  '
