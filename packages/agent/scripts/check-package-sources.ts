import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const failures: string[] = [];
const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
	devDependencies: Record<string, string>;
};
const supportedPiVersion = rootManifest.devDependencies["@earendil-works/pi-coding-agent"];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(supportedPiVersion))
	failures.push("The development Pi version must be an exact version.");
for (const [name, version] of Object.entries(rootManifest.devDependencies)) {
	if (name.startsWith("@earendil-works/pi-") && version !== supportedPiVersion)
		failures.push(`Development dependency ${name} must match Pi ${supportedPiVersion}; found ${version}.`);
}
for (const [path, peers] of [
	[
		"packages/agent/package.json",
		["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"],
	],
	["packages/tui/package.json", ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]],
] as const) {
	const manifest = JSON.parse(readFileSync(join(root, path), "utf8")) as {
		peerDependencies: Record<string, string>;
		dependencies: Record<string, string> | undefined;
	};
	for (const name of peers) {
		if (manifest.peerDependencies[name] !== supportedPiVersion)
			failures.push(
				`${path}: peer ${name} must match Pi ${supportedPiVersion}; found ${manifest.peerDependencies[name]}.`,
			);
	}
	for (const name of Object.keys(manifest.dependencies ?? {})) {
		if (name.startsWith("@earendil-works/pi-"))
			failures.push(`${path}: ${name} must be a peer, not a bundled dependency.`);
	}
}
const forbiddenFragments = [
	Buffer.from("YXRoZW5haGVhbHRoLmNvbQ==", "base64").toString("utf8"),
	Buffer.from("YXJ0aWZhY3Rvcnk=", "base64").toString("utf8"),
];

const npmrc = readFileSync(join(root, ".npmrc"), "utf8");
const npmConfig = new Map(
	npmrc
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"))
		.map((line) => {
			const separator = line.indexOf("=");
			return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
		}),
);
if (npmConfig.get("registry") !== "https://registry.npmjs.org/")
	failures.push(".npmrc must set registry=https://registry.npmjs.org/");
if (npmConfig.get("replace-registry-host") !== "always") failures.push(".npmrc must set replace-registry-host=always");

const trackedFiles = execFileSync("git", ["ls-files", "-z"], { cwd: root })
	.toString("utf8")
	.split("\0")
	.filter(Boolean);
for (const path of trackedFiles) {
	if (!existsSync(join(root, path))) continue;
	const content = readFileSync(join(root, path));
	if (content.includes(0)) continue;
	const text = content.toString("utf8").toLowerCase();
	for (const fragment of forbiddenFragments) {
		if (text.includes(fragment)) failures.push(`${path} contains forbidden private package source text`);
	}
}

const lockfile = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as {
	packages: Record<string, { resolved?: string }>;
};
for (const [path, entry] of Object.entries(lockfile.packages)) {
	if (!entry.resolved || entry.resolved.startsWith("packages/")) continue;
	let hostname: string;
	try {
		hostname = new URL(entry.resolved).hostname;
	} catch {
		failures.push(`${path} has invalid package source ${entry.resolved}`);
		continue;
	}
	if (hostname !== "registry.npmjs.org") failures.push(`${path} uses unapproved package source host ${hostname}`);
}

if (failures.length) {
	console.error(failures.join("\n"));
	process.exitCode = 1;
} else {
	console.log("Package sources are public and approved; Pi compatibility pins match.");
}
