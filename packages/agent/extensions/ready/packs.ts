export type PackCapability = "format" | "lint" | "types" | "dead" | "complexity" | "dup" | "boundaries";

export interface PackTool {
	name: string;
	/** Project-relative paths; any hit means the tool is configured. */
	detectFiles: string[];
	/** Substrings matched against package.json scripts / mise task bodies / CI text. */
	detectText?: string[];
}

export interface LanguagePack {
	id: string;
	label: string;
	/** Manifest or config files that activate this pack. */
	detectFiles: string[];
	capabilities: Partial<Record<PackCapability, { tools: PackTool[]; unsupportedReason?: string }>>;
}

/** TS/JS Node-oriented pack. Deno overlay is separate. */
const TYPESCRIPT_PACK: LanguagePack = {
	id: "typescript",
	label: "TypeScript / JavaScript",
	detectFiles: ["package.json", "tsconfig.json", "tsconfig.base.json", "jsconfig.json"],
	capabilities: {
		format: {
			tools: [
				{ name: "oxfmt", detectFiles: [".oxfmtrc.jsonc", ".oxfmtrc.json"] },
				{
					name: "prettier",
					detectFiles: [
						".prettierrc",
						".prettierrc.json",
						".prettierrc.js",
						".prettierrc.cjs",
						"prettier.config.js",
						"prettier.config.cjs",
						"prettier.config.mjs",
					],
					detectText: ["prettier"],
				},
				{ name: "biome", detectFiles: ["biome.json", "biome.jsonc"], detectText: ["biome"] },
				{ name: "dprint", detectFiles: ["dprint.json", "dprint.jsonc", ".dprint.json"], detectText: ["dprint"] },
			],
		},
		lint: {
			tools: [
				{
					name: "oxlint",
					detectFiles: [".oxlintrc.jsonc", ".oxlintrc.json", "oxlint.config.ts"],
					detectText: ["oxlint"],
				},
				{
					name: "eslint",
					detectFiles: [
						"eslint.config.js",
						"eslint.config.mjs",
						"eslint.config.cjs",
						"eslint.config.ts",
						".eslintrc",
						".eslintrc.js",
						".eslintrc.cjs",
						".eslintrc.json",
						".eslintrc.yml",
					],
					detectText: ["eslint"],
				},
				{ name: "biome", detectFiles: ["biome.json", "biome.jsonc"], detectText: ["biome lint"] },
			],
		},
		types: {
			tools: [{ name: "tsc", detectFiles: ["tsconfig.json", "tsconfig.base.json"], detectText: ["tsc", "tsgo"] }],
		},
		dead: {
			tools: [
				{
					name: "fallow",
					detectFiles: [".fallowrc.json", ".fallowrc.jsonc", "fallow.toml", ".fallow.toml"],
					detectText: ["fallow"],
				},
				{
					name: "knip",
					detectFiles: ["knip.json", "knip.jsonc", ".knip.json", "knip.ts", "knip.config.ts"],
					detectText: ["knip"],
				},
			],
		},
		complexity: {
			tools: [
				{
					name: "fallow health",
					detectFiles: [".fallowrc.json", ".fallowrc.jsonc", "fallow.toml", ".fallow.toml"],
					detectText: ["fallow health", "fallow --only health", "fallow --only dead-code,dupes,health"],
				},
			],
		},
		dup: {
			tools: [
				{
					name: "fallow dupes",
					detectFiles: [".fallowrc.json", ".fallowrc.jsonc", "fallow.toml", ".fallow.toml"],
					detectText: ["fallow", "dupes"],
				},
				{ name: "jscpd", detectFiles: [".jscpd.json"], detectText: ["jscpd", "cpd"] },
			],
		},
		boundaries: {
			tools: [
				{
					name: "fallow boundaries",
					detectFiles: [".fallowrc.json", ".fallowrc.jsonc", "fallow.toml", ".fallow.toml"],
					detectText: ["boundary"],
				},
				{
					name: "dependency-cruiser",
					detectFiles: [
						".dependency-cruiser.js",
						".dependency-cruiser.cjs",
						".dependency-cruiser.mjs",
						".dependency-cruiser.json",
					],
					detectText: ["dependency-cruiser", "depcruise"],
				},
			],
		},
	},
};

const DENO_PACK: LanguagePack = {
	id: "deno",
	label: "Deno",
	detectFiles: ["deno.json", "deno.jsonc"],
	capabilities: {
		format: {
			tools: [{ name: "deno fmt", detectFiles: ["deno.json", "deno.jsonc"], detectText: ["deno fmt"] }],
		},
		lint: {
			tools: [{ name: "deno lint", detectFiles: ["deno.json", "deno.jsonc"], detectText: ["deno lint"] }],
		},
		types: {
			tools: [{ name: "deno check", detectFiles: ["deno.json", "deno.jsonc"], detectText: ["deno check"] }],
		},
		dead: {
			tools: [],
			unsupportedReason: "No Knip-class whole-repo dead-code tool for Deno; deno lint covers locals only",
		},
		complexity: {
			tools: [],
			unsupportedReason: "No core Deno complexity gate; community lint plugins only",
		},
		dup: {
			tools: [{ name: "jscpd", detectFiles: [".jscpd.json"], detectText: ["jscpd", "cpd"] }],
		},
		boundaries: {
			tools: [
				{
					name: "deno-import-check",
					detectFiles: [],
					detectText: ["deno-import-check", "@cunarist/deno-import-check"],
				},
			],
		},
	},
};

/** Thin packs: language present + types/build gate only for v1 ceiling honesty. */
const GO_PACK: LanguagePack = {
	id: "go",
	label: "Go",
	detectFiles: ["go.mod"],
	capabilities: {
		format: {
			tools: [{ name: "gofmt", detectFiles: ["go.mod"], detectText: ["gofmt", "gofumpt", "go fmt"] }],
		},
		lint: {
			tools: [
				{
					name: "golangci-lint",
					detectFiles: [".golangci.yml", ".golangci.yaml", ".golangci.toml", ".golangci.json"],
					detectText: ["golangci-lint"],
				},
			],
		},
		types: {
			tools: [{ name: "go build/test", detectFiles: ["go.mod"], detectText: ["go build", "go test", "go vet"] }],
		},
		dead: {
			tools: [{ name: "deadcode/unused", detectFiles: [], detectText: ["deadcode", "staticcheck", "unused"] }],
		},
		complexity: {
			tools: [{ name: "gocyclo/cyclop", detectFiles: [], detectText: ["gocyclo", "cyclop", "gocognit"] }],
		},
		dup: {
			tools: [{ name: "dupl", detectFiles: [], detectText: ["dupl"] }],
		},
		boundaries: {
			tools: [{ name: "internal/depguard", detectFiles: [], detectText: ["depguard", "go-arch-lint"] }],
		},
	},
};

const RUST_PACK: LanguagePack = {
	id: "rust",
	label: "Rust",
	detectFiles: ["Cargo.toml"],
	capabilities: {
		format: {
			tools: [
				{
					name: "rustfmt",
					detectFiles: ["rustfmt.toml", ".rustfmt.toml", "Cargo.toml"],
					detectText: ["cargo fmt"],
				},
			],
		},
		lint: {
			tools: [
				{
					name: "clippy",
					detectFiles: ["clippy.toml", ".clippy.toml", "Cargo.toml"],
					detectText: ["cargo clippy"],
				},
			],
		},
		types: {
			tools: [
				{
					name: "cargo check",
					detectFiles: ["Cargo.toml"],
					detectText: ["cargo check", "cargo build", "cargo test"],
				},
			],
		},
		dead: {
			tools: [{ name: "dead_code/machete", detectFiles: [], detectText: ["cargo machete", "dead_code"] }],
		},
		complexity: {
			tools: [],
			unsupportedReason: "No dominant Rust complexity-budget tool in baseline pack",
		},
		dup: {
			tools: [{ name: "jscpd", detectFiles: [".jscpd.json"], detectText: ["jscpd"] }],
		},
		boundaries: {
			tools: [
				{ name: "cargo-deny", detectFiles: ["deny.toml"], detectText: ["cargo deny"] },
				{ name: "cargo-modules", detectFiles: [], detectText: ["cargo modules"] },
			],
		},
	},
};

export const LANGUAGE_PACKS: LanguagePack[] = [DENO_PACK, TYPESCRIPT_PACK, GO_PACK, RUST_PACK];

export const CAPABILITY_LABELS: Record<PackCapability, string> = {
	format: "Format",
	lint: "Lint",
	types: "Types / build",
	dead: "Dead / unused",
	complexity: "Complexity",
	dup: "Duplication",
	boundaries: "Boundaries",
};

export const CAPABILITY_ORDER: PackCapability[] = [
	"format",
	"lint",
	"types",
	"dead",
	"complexity",
	"dup",
	"boundaries",
];
