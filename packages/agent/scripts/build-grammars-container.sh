#!/usr/bin/env bash
# Rebuilds the vendored grammar wasm artifacts on a machine where the wasi-sdk
# toolchain cannot run natively (managed macOS kills unsigned downloaded
# binaries). Downloads pinned toolchains and grammar sources on the host, then
# compiles inside an offline Linux container.
#
# On Linux this delegates to build-grammars.ts, which is also the CI entry
# (.github/workflows/grammars.yml).
#
# Requirements on macOS: a Docker-compatible runtime (OrbStack or Rancher
# Desktop). Override the image with TAU_GRAMMAR_IMAGE when pulling through a
# registry mirror, e.g. TAU_GRAMMAR_IMAGE=<mirror-host>/node:24-trixie.
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
grammars_dir="$repo_root/packages/agent/src/ast/grammars"

if [[ "$(uname -s)" == "Linux" ]]; then
	exec node --experimental-strip-types "$script_dir/build-grammars.ts"
fi

image="${TAU_GRAMMAR_IMAGE:-node:24-trixie}"

case "$(uname -m)" in
	arm64 | aarch64)
		ts_arch="arm64"
		sdk_arch="arm64"
		;;
	x86_64)
		ts_arch="x64"
		sdk_arch="x86_64"
		;;
	*)
		echo "unsupported host architecture: $(uname -m)" >&2
		exit 1
		;;
esac

read -r cli_version wasi_sdk < <(node -e '
	const m = require(process.argv[1]);
	console.log(`${m.treeSitterCli} ${m.wasiSdk}`);
' "$grammars_dir/manifest.json")

work="$HOME/.cache/tau-grammars"
rm -rf "$work/src"
mkdir -p "$work/in" "$work/src"

ts_gz="$work/in/tree-sitter-$cli_version-linux-$ts_arch.gz"
sdk_tar="$work/in/$wasi_sdk-$sdk_arch-linux.tar.gz"
sdk_version="${wasi_sdk#wasi-sdk-}"
[[ -f "$ts_gz" ]] || curl -fsSL -o "$ts_gz" \
	"https://github.com/tree-sitter/tree-sitter/releases/download/v$cli_version/tree-sitter-linux-$ts_arch.gz"
[[ -f "$sdk_tar" ]] || curl -fsSL -o "$sdk_tar" \
	"https://github.com/WebAssembly/wasi-sdk/releases/download/$wasi_sdk/$sdk_version.0-$sdk_arch-linux.tar.gz"

build_ids=()
while IFS=$'\t' read -r id source repo rev subdir url; do
	case "$source" in
		release)
			echo "[$id] downloading pinned release artifact"
			curl -fsSL -o "$grammars_dir/$id.wasm" "$url"
			;;
		built)
			echo "[$id] cloning $repo @ $rev"
			git init --quiet "$work/src/$id"
			git -C "$work/src/$id" remote add origin "$repo"
			git -C "$work/src/$id" fetch --quiet --depth 1 origin "$rev"
			git -C "$work/src/$id" checkout --quiet FETCH_HEAD
			build_ids+=("$id::$subdir")
			;;
	esac
done < <(node -e '
	const m = require(process.argv[1]);
	for (const g of m.grammars) {
		if (g.source === "vscode") continue;
		console.log([g.id, g.source, g.repo ?? "", g.rev ?? "", g.subdir ?? "", g.url ?? ""].join("\t"));
	}
' "$grammars_dir/manifest.json")

if [[ "${#build_ids[@]}" -eq 0 ]]; then
	echo "no built-source grammars in manifest; done"
	exit 0
fi

docker run --rm --network none \
	-v "$work/in":/in:ro \
	-v "$work/src":/src:ro \
	-v "$grammars_dir":/out \
	-e BUILD_IDS="${build_ids[*]}" \
	"$image" bash -c '
set -euo pipefail
gunzip -c /in/*.gz > /usr/local/bin/tree-sitter && chmod +x /usr/local/bin/tree-sitter
tree-sitter --version
mkdir -p /root/.cache/tree-sitter/wasi-sdk
tar -xzf /in/*.tar.gz --strip-components=1 -C /root/.cache/tree-sitter/wasi-sdk
for entry in $BUILD_IDS; do
	id="${entry%%::*}"
	subdir="${entry##*::}"
	src="/src/$id"
	[ "$subdir" != "." ] && src="$src/$subdir"
	if [ ! -f "$src/src/parser.c" ]; then
		workdir="/tmp/gen-$id"
		cp -R "$src" "$workdir"
		(cd "$workdir" && tree-sitter generate)
		src="$workdir"
	fi
	tree-sitter build --wasm -o "/out/$id.wasm" "$src"
	echo "built $id"
done'

echo "done: artifacts current in $grammars_dir"
