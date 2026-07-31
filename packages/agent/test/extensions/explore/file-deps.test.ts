import { describe, expect, test } from "vitest";
import type { FileDepHit } from "../../../src/ast/graph/file-graph.ts";
import { withExplore, type ExploreFixture } from "./helpers.ts";

async function deps(fixture: ExploreFixture, path: string, resultLimit = 20): Promise<FileDepHit[]> {
	const result = await fixture.graph.deps(path, 1, resultLimit, fixture.signal);
	return result.hits;
}

function internalNames(hits: readonly FileDepHit[]): string[] {
	return hits.flatMap((hit) => (hit.kind === "internal" ? [hit.path.split("/").at(-1) ?? hit.path] : []));
}

function packageDirs(hits: readonly FileDepHit[]): string[] {
	return hits.flatMap((hit) => (hit.kind === "package" ? [hit.dir.split("/").slice(-2).join("/")] : []));
}

describe("file dependency resolution", () => {
	test("java resolves across sibling modules and folds wildcards into a package edge", async () => {
		await withExplore(
			{
				"modA/src/main/java/com/example/a/Service.java":
					"package com.example.a;\n\nimport com.example.b.Repo;\nimport com.example.b.util.*;\n\npublic class Service {}\n",
				"modB/src/main/java/com/example/b/Repo.java": "package com.example.b;\n\npublic class Repo {}\n",
				"modB/src/main/java/com/example/b/util/Helpers.java":
					"package com.example.b.util;\n\npublic class Helpers {}\n",
			},
			async (fixture) => {
				const hits = await deps(fixture, "modA/src/main/java/com/example/a/Service.java");
				expect(internalNames(hits)).toEqual(["Repo.java"]);
				expect(packageDirs(hits)).toEqual(["b/util"]);
				expect(hits.filter((hit) => hit.kind === "external")).toHaveLength(0);
			},
		);
	});

	test("kotlin resolves a type whose file name differs and a top-level member import", async () => {
		await withExplore(
			{
				"modA/src/main/kotlin/com/example/a/Client.kt":
					"package com.example.a\n\nimport com.example.b.Widget\nimport com.example.b.buildWidget\n\nclass Client\n",
				"modB/src/main/kotlin/com/example/b/models.kt":
					"package com.example.b\n\nclass Widget\n\nfun buildWidget(): Widget = Widget()\n",
			},
			async (fixture) => {
				const hits = await deps(fixture, "modA/src/main/kotlin/com/example/a/Client.kt");
				expect(internalNames(hits)).toEqual(["models.kt"]);
				expect(packageDirs(hits)).toEqual(["example/b"]);
			},
		);
	});

	test("a c# namespace using resolves to its directory, an alias using to one file", async () => {
		await withExplore(
			{
				"src/Core/Entities/Item.cs": "namespace Media.Controller.Entities;\n\npublic class Item {}\n",
				"src/Core/Entities/Folder.cs": "namespace Media.Controller.Entities;\n\npublic class Folder {}\n",
				"src/Api/Manager.cs":
					"using Media.Controller.Entities;\nusing Alias = Media.Controller.Entities.Item;\n\nnamespace Media.Api;\n\npublic class Manager {}\n",
			},
			async (fixture) => {
				const hits = await deps(fixture, "src/Api/Manager.cs");
				expect(internalNames(hits)).toEqual(["Item.cs"]);
				const packageHit = hits.find((hit) => hit.kind === "package");
				expect(packageHit?.kind === "package" ? packageHit.fileCount : 0).toBe(2);
				expect(packageDirs(hits)).toEqual(["Core/Entities"]);
			},
		);
	});

	test("typescript resolves workspace packages without following node_modules", async () => {
		await withExplore(
			{
				"package.json": '{ "name": "root", "private": true, "workspaces": ["packages/*"] }\n',
				"packages/lib/package.json": '{ "name": "@scope/lib", "main": "./src/index.ts" }\n',
				"packages/lib/src/index.ts": "export const value = 1;\n",
				"packages/app/package.json": '{ "name": "@scope/app" }\n',
				"packages/app/src/main.ts": 'import { value } from "@scope/lib";\n\nexport const doubled = value * 2;\n',
			},
			async (fixture) => {
				const hits = await deps(fixture, "packages/app/src/main.ts");
				expect(hits.filter((hit) => hit.kind === "internal").map((hit) => hit.path.includes("/lib/src/"))).toEqual([
					true,
				]);
			},
		);
	});

	test("a swift module import is one package edge, not every file in the module", async () => {
		await withExplore(
			{
				"Package.swift": "// swift-tools-version:5.9\nimport PackageDescription\n",
				"Sources/Core/Model.swift": "public struct Model {\n\tpublic let value: Int\n}\n",
				"Sources/Core/Extra.swift": "public struct Extra {\n\tpublic let value: Int\n}\n",
				"Sources/App/main.swift": "import Core\n\nlet model = Model(value: 1)\n",
			},
			async (fixture) => {
				const hits = await deps(fixture, "Sources/App/main.swift");
				const packageHit = hits.find((hit) => hit.kind === "package");
				expect(packageHit?.kind === "package" ? packageHit.fileCount : 0).toBe(2);
				expect(hits.filter((hit) => hit.kind === "internal")).toHaveLength(0);
			},
		);
	});

	test("go stdlib imports cannot crowd out the in-repo edge", async () => {
		const stdlib = [
			"bytes",
			"context",
			"errors",
			"fmt",
			"io",
			"log",
			"os",
			"sort",
			"strconv",
			"strings",
			"sync",
			"time",
		];
		await withExplore(
			{
				"go.mod": "module example.com/m\n\ngo 1.22\n",
				"pkg/util/util.go": "package util\n\nfunc Do() {}\n",
				"main.go": `package main\n\nimport (\n${stdlib
					.map((pkg) => `\t"${pkg}"\n`)
					.join("")}\t"example.com/m/pkg/util"\n)\n\nfunc main() {\n\tutil.Do()\n}\n`,
			},
			async (fixture) => {
				const result = await fixture.graph.deps("main.go", 1, 20, fixture.signal);
				expect(internalNames(result.hits)).toEqual(["util.go"]);
				expect(result.hits.filter((hit) => hit.kind === "external")).toHaveLength(10);
				expect(result.externalOmitted).toBe(2);
			},
		);
	});

	test("an unresolvable rust use path falls back to the deepest module that exists", async () => {
		await withExplore(
			{
				"Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\n',
				"src/lib.rs": "pub mod loom;\npub mod thing;\n",
				"src/loom/mod.rs": "pub(crate) mod cell {\n\tpub struct UnsafeCell;\n}\n",
				"src/thing.rs": "use crate::loom::cell::UnsafeCell;\n\npub fn take(_cell: UnsafeCell) {}\n",
			},
			async (fixture) => {
				const hits = await deps(fixture, "src/thing.rs");
				expect(internalNames(hits)).toEqual(["mod.rs"]);
			},
		);
	});
});
