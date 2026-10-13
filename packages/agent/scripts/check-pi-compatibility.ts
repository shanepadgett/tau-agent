import { readFileSync } from "node:fs";
import { join } from "node:path";
import { satisfies, valid } from "semver";

const root = process.cwd();
const failures: string[] = [];
const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
	devDependencies: Record<string, string>;
};
const developmentPiVersion = rootManifest.devDependencies["@earendil-works/pi-coding-agent"];
if (valid(developmentPiVersion) !== developmentPiVersion)
	failures.push("The development Pi version must be an exact version.");
for (const [name, version] of Object.entries(rootManifest.devDependencies)) {
	if (name.startsWith("@earendil-works/pi-") && version !== developmentPiVersion)
		failures.push(`Development dependency ${name} must match Pi ${developmentPiVersion}; found ${version}.`);
}
const agentManifest = JSON.parse(readFileSync(join(root, "packages/agent/package.json"), "utf8")) as {
	peerDependencies: Record<string, string>;
};
const supportedPiRange = agentManifest.peerDependencies["@earendil-works/pi-coding-agent"];
if (!/^>=\d+\.\d+\.\d+$/.test(supportedPiRange))
	failures.push("The Pi peer range must declare a stable minimum as >=x.y.z.");
if (!satisfies(developmentPiVersion, supportedPiRange))
	failures.push(`Development Pi ${developmentPiVersion} must satisfy the supported range ${supportedPiRange}.`);
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
		if (manifest.peerDependencies[name] !== supportedPiRange)
			failures.push(
				`${path}: peer ${name} must match Pi ${supportedPiRange}; found ${manifest.peerDependencies[name]}.`,
			);
	}
	for (const name of Object.keys(manifest.dependencies ?? {})) {
		if (name.startsWith("@earendil-works/pi-"))
			failures.push(`${path}: ${name} must be a peer, not a bundled dependency.`);
	}
}

if (failures.length) {
	console.error(failures.join("\n"));
	process.exitCode = 1;
} else {
	console.log("Pi development pins satisfy aligned peer minimums.");
}
