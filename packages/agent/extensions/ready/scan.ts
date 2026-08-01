import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { exists, resolveProjectRoot } from "../../shared/settings/paths.ts";
import { type ReadyReport, type ReadyRow, countStatuses, localTimestampLabel, row } from "./model.ts";
import { CAPABILITY_LABELS, CAPABILITY_ORDER, type LanguagePack, LANGUAGE_PACKS, type PackTool } from "./packs.ts";

const POLICY_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".github/copilot-instructions.md", "AGENT.md"];
const VOCAB_FILES = ["docs/VOCABULARY.md", "VOCABULARY.md", "docs/vocabulary.md"];
const COLD_START_DOCS = [
	"docs/CONTRIBUTING.md",
	"CONTRIBUTING.md",
	"docs/HACKING.md",
	"HACKING.md",
	"docs/DEVELOPMENT.md",
	"DEVELOPMENT.md",
];
const TOOLCHAIN_FILES = [
	"mise.toml",
	".mise.toml",
	"devbox.json",
	".tool-versions",
	"flake.nix",
	".devcontainer/devcontainer.json",
	"devcontainer.json",
];
const TASK_RUNNER_FILES = [
	"mise.toml",
	".mise.toml",
	"justfile",
	"Justfile",
	"Makefile",
	"Taskfile.yml",
	"Taskfile.yaml",
];
const STANDARDS_DIRS = ["docs/standards", ".pi/standards", "standards"];
const BOOTSTRAP_SCRIPTS = ["scripts/bootstrap.sh", "scripts/setup.sh", "bin/setup", "bootstrap.sh", "setup.sh"];
const AGENTS_WEAK_BYTES = 24_000;
const AGENTS_WEAK_LINES = 400;

interface FsIndex {
	root: string;
	files: Set<string>;
	textBlobs: string[];
	packageScripts: string;
	miseText: string;
	ciText: string;
	tauSettingsText: string;
	fallowText: string;
}

export async function scanReadyReport(cwd: string): Promise<ReadyReport> {
	const root = await resolveProjectRoot(cwd);
	const fs = await buildFsIndex(root);
	const languages = detectLanguages(fs);
	const packs = LANGUAGE_PACKS.filter((pack) => languages.includes(pack.id));
	const rows: ReadyRow[] = [...(await scanGeneral(fs)), ...scanLintEntropy(fs, packs, languages)];
	const generatedAt = new Date();
	return {
		generatedAt: generatedAt.toISOString(),
		generatedAtLabel: localTimestampLabel(generatedAt),
		root,
		languages,
		rows,
		counts: countStatuses(rows),
	};
}

async function buildFsIndex(root: string): Promise<FsIndex> {
	const files = new Set<string>();
	const probe = [
		...POLICY_FILES,
		...VOCAB_FILES,
		...COLD_START_DOCS,
		...TOOLCHAIN_FILES,
		...TASK_RUNNER_FILES,
		...BOOTSTRAP_SCRIPTS,
		"README.md",
		"package.json",
		"package-lock.json",
		"pnpm-lock.yaml",
		"yarn.lock",
		"bun.lock",
		"deno.json",
		"deno.jsonc",
		"tsconfig.json",
		"tsconfig.base.json",
		"jsconfig.json",
		"go.mod",
		"Cargo.toml",
		"rustfmt.toml",
		".rustfmt.toml",
		"clippy.toml",
		".clippy.toml",
		"deny.toml",
		".golangci.yml",
		".golangci.yaml",
		".golangci.toml",
		".golangci.json",
		".oxfmtrc.jsonc",
		".oxfmtrc.json",
		".oxlintrc.jsonc",
		".oxlintrc.json",
		"oxlint.config.ts",
		"biome.json",
		"biome.jsonc",
		"dprint.json",
		"dprint.jsonc",
		".fallowrc.json",
		".fallowrc.jsonc",
		"fallow.toml",
		".fallow.toml",
		"knip.json",
		"knip.jsonc",
		".knip.json",
		"knip.ts",
		"knip.config.ts",
		".jscpd.json",
		".dependency-cruiser.js",
		".dependency-cruiser.cjs",
		".dependency-cruiser.mjs",
		".dependency-cruiser.json",
		".prettierrc",
		".prettierrc.json",
		".prettierrc.js",
		".prettierrc.cjs",
		"prettier.config.js",
		"prettier.config.cjs",
		"prettier.config.mjs",
		"eslint.config.js",
		"eslint.config.mjs",
		"eslint.config.cjs",
		"eslint.config.ts",
		".eslintrc",
		".eslintrc.js",
		".eslintrc.cjs",
		".eslintrc.json",
		".eslintrc.yml",
		".pi/tau/settings.json",
		".pi/contexts",
	];

	await Promise.all(
		probe.map(async (rel) => {
			if (await exists(join(root, rel))) files.add(rel);
		}),
	);

	for (const dir of [".github/workflows", ".pi/extensions", "docs/standards", ".pi/standards", "standards"]) {
		if (await exists(join(root, dir))) files.add(dir);
	}

	const workflowNames = await listNames(join(root, ".github/workflows"));
	for (const name of workflowNames) files.add(`.github/workflows/${name}`);
	const extensionNames = await listNames(join(root, ".pi/extensions"));
	for (const name of extensionNames) files.add(`.pi/extensions/${name}`);
	const contextTop = await listNames(join(root, ".pi/contexts"));
	for (const name of contextTop) files.add(`.pi/contexts/${name}`);

	const packageScripts = await readPackageScriptBlob(root);
	const miseText =
		(await readIfExists(join(root, "mise.toml"))) ?? (await readIfExists(join(root, ".mise.toml"))) ?? "";
	const ciText = await readCiBlob(root, workflowNames);
	const tauSettingsText = (await readIfExists(join(root, ".pi/tau/settings.json"))) ?? "";
	const fallowText =
		(await readIfExists(join(root, ".fallowrc.jsonc"))) ??
		(await readIfExists(join(root, ".fallowrc.json"))) ??
		(await readIfExists(join(root, "fallow.toml"))) ??
		(await readIfExists(join(root, ".fallow.toml"))) ??
		"";

	return {
		root,
		files,
		textBlobs: [packageScripts, miseText, ciText, tauSettingsText, fallowText],
		packageScripts,
		miseText,
		ciText,
		tauSettingsText,
		fallowText,
	};
}

function detectLanguages(fs: FsIndex): string[] {
	const ids: string[] = [];
	const has = (rel: string) => fs.files.has(rel);
	if (has("deno.json") || has("deno.jsonc")) ids.push("deno");
	if (has("package.json") || has("tsconfig.json") || has("tsconfig.base.json") || has("jsconfig.json")) {
		ids.push("typescript");
	}
	if (has("go.mod")) ids.push("go");
	if (has("Cargo.toml")) ids.push("rust");
	return ids;
}

async function scanGeneral(fs: FsIndex): Promise<ReadyRow[]> {
	const rows: ReadyRow[] = [];
	const has = (rel: string) => fs.files.has(rel);
	const any = (rels: readonly string[]) => rels.filter((rel) => has(rel));

	const coldDocs = any(COLD_START_DOCS);
	const bootstraps = any(BOOTSTRAP_SCRIPTS);
	if (coldDocs.length > 0) {
		rows.push(
			row({
				id: "cold-start.doc",
				area: "cold-start",
				title: "Cold-start documentation",
				status: "pass",
				evidence: coldDocs,
				note: "Contributor/dev bootstrap doc present (content quality not judged in scan).",
				next: bootstraps.length === 0 ? "Optional: add a bootstrap script that matches the doc." : undefined,
			}),
		);
	} else if (has("README.md")) {
		rows.push(
			row({
				id: "cold-start.doc",
				area: "cold-start",
				title: "Cold-start documentation",
				status: "weak",
				evidence: ["README.md"],
				note: "Only README found. Prefer a dedicated CONTRIBUTING/HACKING cold-start path.",
				next: "Add docs/CONTRIBUTING.md (or similar) with ordered clean-machine steps ending in verify.",
			}),
		);
	} else {
		rows.push(
			row({
				id: "cold-start.doc",
				area: "cold-start",
				title: "Cold-start documentation",
				status: "missing",
				note: "No CONTRIBUTING/HACKING/DEVELOPMENT doc or README.",
				next: "Document ordered install → verify from a clean machine.",
			}),
		);
	}
	if (bootstraps.length > 0) {
		rows.push(
			row({
				id: "cold-start.script",
				area: "cold-start",
				title: "Bootstrap script",
				status: "pass",
				evidence: bootstraps,
				note: "Bootstrap/setup script path present.",
			}),
		);
	}

	const toolchain = any(TOOLCHAIN_FILES);
	rows.push(
		toolchain.length > 0
			? row({
					id: "toolchain.pin",
					area: "toolchain",
					title: "Pinned toolchain",
					status: "pass",
					evidence: toolchain,
					note: "Toolchain pin or devcontainer-style bootstrap config found.",
				})
			: row({
					id: "toolchain.pin",
					area: "toolchain",
					title: "Pinned toolchain",
					status: "missing",
					note: "No mise/devbox/asdf/nix/devcontainer pin detected.",
					next: "Add a reproducible toolchain pin (mise.toml is a common choice).",
				}),
	);

	const taskFiles = any(TASK_RUNNER_FILES);
	const npmScripts = extractNpmScriptNames(fs.packageScripts);
	const miseTasks = extractMiseTaskNames(fs.miseText);
	if (taskFiles.length > 0 || npmScripts.length > 0) {
		rows.push(
			row({
				id: "toolchain.tasks",
				area: "toolchain",
				title: "Task runner",
				status: "pass",
				evidence: [...taskFiles, ...npmScripts.slice(0, 12).map((name) => `npm:${name}`)],
				note: "Named tasks or package scripts found.",
			}),
		);
	} else {
		rows.push(
			row({
				id: "toolchain.tasks",
				area: "toolchain",
				title: "Task runner",
				status: "missing",
				note: "No mise/just/make/taskfile/npm scripts detected.",
				next: "Add a task runner with a single verify entrypoint.",
			}),
		);
	}

	const verifyNames = findVerifyNames(miseTasks, npmScripts, fs);
	if (verifyNames.length > 0) {
		const ciHits = verifyNames.filter(
			(name) => textIncludes(fs.ciText, name) || textIncludes(fs.ciText, `mise run ${name.replace(/^mise:/, "")}`),
		);
		rows.push(
			row({
				id: "verify.entry",
				area: "verify",
				title: "Verify entrypoint",
				status: "pass",
				evidence: verifyNames,
				note: "Conventional verify/check task or script found.",
			}),
		);
		if (fs.files.has(".github/workflows") || fs.ciText.length > 0) {
			rows.push(
				row({
					id: "verify.ci",
					area: "verify",
					title: "CI parity (heuristic)",
					status: ciHits.length > 0 ? "pass" : "weak",
					evidence:
						ciHits.length > 0 ? ciHits.map((name) => `ci mentions ${name}`) : [".github/workflows present"],
					note:
						ciHits.length > 0
							? "CI text appears to reference a verify task."
							: "Workflows present but verify task name not obviously referenced.",
					next: ciHits.length > 0 ? undefined : "Make CI run the same verify entry humans and agents use.",
				}),
			);
		}
	} else {
		rows.push(
			row({
				id: "verify.entry",
				area: "verify",
				title: "Verify entrypoint",
				status: "missing",
				note: "No check/verify/ci-style task name detected.",
				next: "Add one verify task (e.g. mise run check) that aggregates format/lint/types/entropy.",
			}),
		);
	}

	const silentConfigured =
		/"silentCommandRunner"\s*:/.test(fs.tauSettingsText) &&
		/"commands"\s*:\s*\[/.test(fs.tauSettingsText) &&
		!/"commands"\s*:\s*\[\s*\]/.test(fs.tauSettingsText);
	if (fs.files.has(".pi/tau/settings.json") && /"silentCommandRunner"\s*:/.test(fs.tauSettingsText)) {
		rows.push(
			row({
				id: "verify.silent",
				area: "verify",
				title: "Silent command runner",
				status: silentConfigured ? "pass" : "weak",
				evidence: [".pi/tau/settings.json"],
				note: silentConfigured
					? "silentCommandRunner has configured commands."
					: "silentCommandRunner section present but commands look empty.",
				next: silentConfigured
					? undefined
					: "Configure extensions.silentCommandRunner.commands for post-edit verify.",
			}),
		);
	} else {
		rows.push(
			row({
				id: "verify.silent",
				area: "verify",
				title: "Silent command runner",
				status: "missing",
				note: "No Tau silentCommandRunner configuration detected.",
				next: "Wire automatic verify after edits via extensions.silentCommandRunner.",
			}),
		);
	}

	const policy = any(POLICY_FILES);
	if (policy.length > 0) {
		const primary = policy[0];
		const text = primary ? await readIfExists(join(fs.root, primary)) : undefined;
		const bytes = text === undefined ? 0 : Buffer.byteLength(text, "utf8");
		const lines = text === undefined ? 0 : text.split(/\r?\n/).length;
		const weakSize = text !== undefined && (bytes > AGENTS_WEAK_BYTES || lines > AGENTS_WEAK_LINES);
		rows.push(
			row({
				id: "policy.agents",
				area: "policy",
				title: "Agent policy file",
				status: weakSize ? "weak" : "pass",
				evidence: [
					...policy,
					...(text !== undefined && primary ? [`${primary}: ${lines} lines, ${bytes} bytes`] : []),
				],
				note: weakSize
					? "Policy file is large; prefer thin always-on law and move playbooks to standards."
					: "Always-on agent policy file present (thinness of content not fully judged).",
				next: weakSize
					? "Split work-type standards out of AGENTS.md; keep durable cross-cutting rules only."
					: undefined,
			}),
		);
	} else {
		rows.push(
			row({
				id: "policy.agents",
				area: "policy",
				title: "Agent policy file",
				status: "missing",
				note: "No AGENTS.md / CLAUDE.md / copilot-instructions file found.",
				next: "Add a thin AGENTS.md with always-on rules and pointers outward.",
			}),
		);
	}

	const vocab = any(VOCAB_FILES);
	rows.push(
		vocab.length > 0
			? row({
					id: "policy.vocabulary",
					area: "policy",
					title: "Vocabulary",
					status: "pass",
					evidence: vocab,
					note: "Shared vocabulary doc found.",
				})
			: row({
					id: "policy.vocabulary",
					area: "policy",
					title: "Vocabulary",
					status: "missing",
					note: "No VOCABULARY.md detected.",
					next: "Add docs/VOCABULARY.md for core nouns agents and humans share.",
				}),
	);

	const standardsHits = STANDARDS_DIRS.filter((dir) => fs.files.has(dir));
	rows.push(
		standardsHits.length > 0
			? row({
					id: "standards.tree",
					area: "standards",
					title: "Standards tree",
					status: "pass",
					evidence: standardsHits,
					note: "Standards directory present (substance not judged in scan).",
				})
			: row({
					id: "standards.tree",
					area: "standards",
					title: "Standards tree",
					status: "missing",
					note: "No docs/standards or .pi/standards tree detected.",
					next: "Add work-type standards outside AGENTS.md (UI, API, extensions, …).",
				}),
	);

	if (fs.files.has(".pi/contexts")) {
		const children = [...fs.files].filter((path) => path.startsWith(".pi/contexts/") && path !== ".pi/contexts");
		rows.push(
			row({
				id: "context.catalog",
				area: "context",
				title: "Context catalog",
				status: children.length > 0 ? "pass" : "weak",
				evidence: children.length > 0 ? children.slice(0, 12) : [".pi/contexts"],
				note:
					children.length > 0
						? "`.pi/contexts` has entries (pack quality not judged in scan)."
						: "`.pi/contexts` exists but looks empty at top level.",
				next: children.length > 0 ? undefined : "Add domain/concept work packs under .pi/contexts.",
			}),
		);
	} else {
		rows.push(
			row({
				id: "context.catalog",
				area: "context",
				title: "Context catalog",
				status: "missing",
				note: "No `.pi/contexts` catalog detected.",
				next: "Create job-shaped context packs for sticky work areas.",
			}),
		);
	}

	const policyBlob = policy[0] ? ((await readIfExists(join(fs.root, policy[0]))) ?? "") : "";
	const goldenHints =
		textIncludes(`${fs.miseText}\n${fs.packageScripts}\n${policyBlob}`, "golden") ||
		[...fs.files].some((path) => /golden|canonical.example/i.test(path));
	rows.push(
		row({
			id: "reuse.golden",
			area: "reuse",
			title: "Golden path pointer",
			status: goldenHints ? "pass" : "unknown",
			evidence: goldenHints ? ["heuristic: golden/canonical mention or path"] : [],
			note: goldenHints
				? "Possible golden-path pointer detected (heuristic)."
				: "Scan cannot confirm a named golden path; check AGENTS/standards manually.",
			next: goldenHints ? undefined : "Name a canonical example per major artifact kind and link it from policy.",
		}),
	);

	const markerHit =
		textIncludes(fs.fallowText, "@agent") ||
		textIncludes(fs.tauSettingsText, "@agent kind") ||
		textIncludes(policyBlob, "@agent kind=");
	rows.push(
		row({
			id: "markers.vocab",
			area: "markers",
			title: "Deterministic markers",
			status: markerHit ? "weak" : "na",
			evidence: markerHit ? ["heuristic marker mention"] : [],
			note: markerHit
				? "Marker-related signal found; full greppable vocabulary not verified."
				: "No marker system required; na unless the repo adopts @agent-style temp/until/invariant tags.",
		}),
	);

	rows.push(
		row({
			id: "harness.gates",
			area: "harness",
			title: "Harness gates",
			status: "unknown",
			note: "Scan does not verify read/write/command gates in v1.",
			next: "Protect rail files and secrets via harness permissions when available.",
		}),
	);

	const localExt = [...fs.files].filter((path) => path.startsWith(".pi/extensions/"));
	const publishExt = localExt.filter((path) => /publish|release|migrate/i.test(path));
	const publishScripts = npmScripts.filter((name) => /publish|release|migrate/i.test(name));
	if (publishExt.length > 0 || publishScripts.length > 0) {
		rows.push(
			row({
				id: "side-effect.verbs",
				area: "side-effect-verbs",
				title: "Side-effect verbs",
				status: "pass",
				evidence: [...publishExt, ...publishScripts.map((name) => `npm:${name}`)],
				note: "Publish/release/migrate-style command or local extension name found.",
			}),
		);
	} else {
		rows.push(
			row({
				id: "side-effect.verbs",
				area: "side-effect-verbs",
				title: "Side-effect verbs",
				status: "na",
				note: "No publish/release/migrate verb detected; fine if the repo has no such ops.",
				next: "Bind side-effectful ops to slash commands or scripts, not agent freestyle.",
			}),
		);
	}

	return rows;
}

function scanLintEntropy(fs: FsIndex, packs: LanguagePack[], languages: string[]): ReadyRow[] {
	if (languages.length === 0) {
		return [
			row({
				id: "lint-entropy.languages",
				area: "lint-entropy",
				title: "Language detection",
				status: "unknown",
				note: "No supported language manifests detected (TS/JS, Deno, Go, Rust).",
			}),
		];
	}

	const rows: ReadyRow[] = [
		row({
			id: "lint-entropy.languages",
			area: "lint-entropy",
			title: "Detected languages",
			status: "pass",
			evidence: languages,
			note: `Active packs: ${packs.map((pack) => pack.label).join(", ")}.`,
		}),
	];

	for (const pack of packs) {
		for (const capability of CAPABILITY_ORDER) {
			const spec = pack.capabilities[capability];
			if (!spec) continue;
			const id = `lint-entropy.${pack.id}.${capability}`;
			const title = `${pack.label}: ${CAPABILITY_LABELS[capability]}`;
			if (spec.unsupportedReason && spec.tools.length === 0) {
				rows.push(
					row({
						id,
						area: "lint-entropy",
						title,
						status: "na",
						note: spec.unsupportedReason,
					}),
				);
				continue;
			}
			const hits = findToolHits(fs, spec.tools);
			if (hits.length > 0) {
				if (
					capability === "complexity" &&
					hits.every((hit) => hit.startsWith("fallow")) &&
					!fallowHealthWired(fs)
				) {
					rows.push(
						row({
							id,
							area: "lint-entropy",
							title,
							status: "weak",
							evidence: hits,
							note: "Fallow present but health/complexity not obviously in verify tasks.",
							next: "Add fallow health (or another complexity gate) to verify if you want complexity budgets.",
						}),
					);
					continue;
				}
				if (
					capability === "boundaries" &&
					hits.some((hit) => hit.startsWith("fallow")) &&
					!textIncludes(fs.fallowText, "boundar") &&
					!textIncludes(fs.miseText, "boundary")
				) {
					rows.push(
						row({
							id,
							area: "lint-entropy",
							title,
							status: "weak",
							evidence: hits,
							note: "Fallow present but boundary zones not detected in config/tasks.",
							next: "Configure Fallow zones or dependency-cruiser if architecture boundaries matter.",
						}),
					);
					continue;
				}
				rows.push(
					row({
						id,
						area: "lint-entropy",
						title,
						status: "pass",
						evidence: hits,
						note: "Known tool configuration or task reference detected.",
					}),
				);
			} else if (spec.unsupportedReason) {
				rows.push(
					row({
						id,
						area: "lint-entropy",
						title,
						status: "na",
						note: spec.unsupportedReason,
					}),
				);
			} else {
				rows.push(
					row({
						id,
						area: "lint-entropy",
						title,
						status: "missing",
						evidence: spec.tools.map((tool) => `looked for ${tool.name}`),
						note: `No ${CAPABILITY_LABELS[capability].toLowerCase()} tool detected for ${pack.label}.`,
						next: `Wire a ${pack.label} ${CAPABILITY_LABELS[capability].toLowerCase()} tool into verify.`,
					}),
				);
			}
		}
	}

	return rows;
}

function findToolHits(fs: FsIndex, tools: readonly PackTool[]): string[] {
	const hits: string[] = [];
	for (const tool of tools) {
		const fileHit = tool.detectFiles.find((rel) => fs.files.has(rel));
		if (fileHit) {
			hits.push(`${tool.name} (${fileHit})`);
			continue;
		}
		const textHit = tool.detectText?.find((needle) => fs.textBlobs.some((blob) => textIncludes(blob, needle)));
		if (textHit) hits.push(`${tool.name} (task/text: ${textHit})`);
	}
	return hits;
}

function fallowHealthWired(fs: FsIndex): boolean {
	return (
		/\bfallow\b[^\n]*\bhealth\b/i.test(fs.miseText) ||
		/\bfallow\b[^\n]*\bhealth\b/i.test(fs.packageScripts) ||
		textIncludes(fs.miseText, "fallow health") ||
		textIncludes(fs.packageScripts, "fallow health")
	);
}

function findVerifyNames(miseTasks: string[], npmScripts: string[], fs: FsIndex): string[] {
	const preferred = ["check", "verify", "ci", "lint", "test"];
	const found = new Set<string>();
	for (const name of miseTasks) {
		if (preferred.some((part) => name === part || name.startsWith(`${part}:`) || name.endsWith(`:${part}`))) {
			found.add(`mise:${name}`);
		}
	}
	for (const name of npmScripts) {
		if (preferred.some((part) => name === part || name.startsWith(`${part}:`))) found.add(`npm:${name}`);
	}
	if (textIncludes(fs.miseText, "[tasks.check]") || textIncludes(fs.ciText, "mise run check")) found.add("mise:check");
	return [...found];
}

function extractMiseTaskNames(miseText: string): string[] {
	const names: string[] = [];
	for (const match of miseText.matchAll(/\[tasks\."([^"]+)"\]/g)) {
		const raw = match[1];
		if (raw) names.push(raw);
	}
	for (const match of miseText.matchAll(/\[tasks\.([A-Za-z0-9_-]+)\]/g)) {
		const raw = match[1];
		if (raw) names.push(raw);
	}
	return [...new Set(names)];
}

function extractNpmScriptNames(packageJsonText: string): string[] {
	if (!packageJsonText) return [];
	try {
		const parsed = JSON.parse(packageJsonText) as { scripts?: Record<string, string> };
		return Object.keys(parsed.scripts ?? {});
	} catch {
		return [];
	}
}

async function readPackageScriptBlob(root: string): Promise<string> {
	const text = await readIfExists(join(root, "package.json"));
	if (!text) return "";
	try {
		const parsed = JSON.parse(text) as {
			scripts?: Record<string, string>;
			devDependencies?: Record<string, string>;
			dependencies?: Record<string, string>;
		};
		return JSON.stringify({
			scripts: parsed.scripts ?? {},
			devDependencies: parsed.devDependencies ?? {},
			dependencies: parsed.dependencies ?? {},
		});
	} catch {
		return text;
	}
}

async function readCiBlob(root: string, workflowNames: string[]): Promise<string> {
	const chunks: string[] = [];
	for (const name of workflowNames.slice(0, 20)) {
		const text = await readIfExists(join(root, ".github/workflows", name));
		if (text) chunks.push(text);
	}
	return chunks.join("\n");
}

async function listNames(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries.map((entry) => entry.name);
	} catch {
		return [];
	}
}

async function readIfExists(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

function textIncludes(haystack: string, needle: string): boolean {
	return haystack.toLowerCase().includes(needle.toLowerCase());
}
