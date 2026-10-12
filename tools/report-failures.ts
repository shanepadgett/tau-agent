/**
 * Runs a check command and prints only what failed.
 *
 * Usage: bun tools/report-failures.ts <profile> -- <command...>
 *
 * A passing command prints nothing. A failing command prints its output without
 * the profile's noise lines (banners, summaries, runner internals), with paths
 * made relative to the working directory. When filtering leaves nothing, the raw
 * output's last lines are printed so a failure is never silent.
 */
import { spawnSync } from "bun";

const PROFILES: Readonly<Record<string, readonly RegExp[]>> = {
  "bun-test": [
    /^bun test v/,
    /^\s*\d+ (pass|fail|skip|todo|snapshots?|filtered out)\b/,
    /^\s*\d+ expect\(\) calls$/,
    /^Ran \d+ tests? across/,
    /^[-+] (Expected|Received)\s+[-+] \d+$/,
  ],
  "node-test": [/^[.X]+$/, /^Failed tests:$/, /^\s+at .*\(node:/, /^\s+at async .*node:/],
  fallow: [/^\[X\] Exit code \d+: gate /],
  plain: [],
};

const RAW_TAIL_LINES = 40;
const TIMING = / \[\d+(\.\d+)?m?s\]$/;

const [profileName, separator, ...command] = Bun.argv.slice(2);
const noise = profileName === undefined ? undefined : PROFILES[profileName];

if (noise === undefined || separator !== "--" || command.length === 0) {
  console.error(
    `Usage: bun tools/report-failures.ts <${Object.keys(PROFILES).join("|")}> -- <command...>`,
  );

  process.exit(2);
}

// Checks run one at a time, so waiting synchronously blocks nothing else.
const { stdout, stderr, exitCode } = spawnSync(command, { stdout: "pipe", stderr: "pipe" });

if (exitCode !== 0) {
  const root = `${process.cwd()}/`;
  const output = `${stdout.toString()}\n${stderr.toString()}`;
  const lines = output.replaceAll(`file://${root}`, "").replaceAll(root, "").split("\n");
  const failures = lines.filter((line) => !noise.some((pattern) => pattern.test(line)));
  const report = failures.map((line) => line.replace(TIMING, "")).join("\n");

  const hasFailureText = report.trim() !== "";
  const shown = hasFailureText ? report : lines.slice(-RAW_TAIL_LINES).join("\n");
  console.log(shown.replaceAll(/\n{3,}/g, "\n\n").trim());
}

process.exit(exitCode);
