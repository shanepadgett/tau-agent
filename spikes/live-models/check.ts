// Live check: do Tau's tools and agent loop work on every model of the live model matrix?
// Builds the tau binary, runs the same prompts on each model in one session in a fresh git
// repository, and grades each prompt from the session entries in ~/.tau/sessions.db and the files.
//
// Run: bun spikes/live-models/check.ts [route/model ...]   (no arguments: the whole matrix)
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Keep in step with "Live model matrix" in docs/plan/tooling.md. */
const MATRIX = [
  "chatgpt/gpt-6-luna",
  "chatgpt/gpt-6.1-sol",
  "codex/gpt-6-luna",
  "codex/gpt-6.1-sol",
  "anthropic/claude-haiku-5-5",
  "anthropic/claude-sonnet-5-5",
  "anthropic/claude-opus-5-5",
  "opencode-go/deepseek-v4.1-flash",
  "opencode-go/kimi-k3",
  "opencode-go/muse-spark-1.3-contributor",
  "opencode-go/minimax-m3",
  "openrouter/google/gemini-3.8-flash",
];

const HERE = import.meta.dir;
const ROOT = join(HERE, "../..");
const BINARY = join(HERE, "dist/tau");
const PROMPT_TIMEOUT_MS = 15 * 60 * 1000;

const VERSION = "4.2.7";
const AGENTS_LINE = "Checked by src rules.";
const SIGNATURE = "Signed: release bot";

const FIXTURE: Record<string, string> = {
  VERSION: `${VERSION}\n`,
  "config.jsonc": '{ "port": 8080 }\n',
  "src/app.js": [
    "export function greetVisitor(name) {",
    "  return `Hello, ${name}!`;",
    "}",
    "",
    'export const greetings = [greetVisitor("Ada"), greetVisitor("Linus")];',
    "",
  ].join("\n"),
  "src/AGENTS.md": `# Rules for src\n\nEnd every answer that mentions a file in this folder with this line: ${AGENTS_LINE}\n`,
  ".tau/skills/release-notes/SKILL.md": [
    "---",
    "name: release-notes",
    "description: Use when you write release notes for this project.",
    "---",
    "",
    "Release notes go in RELEASE.md at the repository root.",
    "The first line is `## <version>`, with the version from the VERSION file.",
    "Then write one line per change, each starting with `- `.",
    `The last line is exactly: ${SIGNATURE}`,
    "",
  ].join("\n"),
};

const PROMPTS = {
  tools:
    "Use sh to print the contents of VERSION, and read src/app.js. Tell me the version and the name of the function src/app.js exports.",
  edits:
    'In src/app.js, rename greetVisitor to welcomeVisitor everywhere, and change "Hello" to "Welcome".',
  scriptFix: [
    "Call run with exactly this program first, unchanged:",
    "",
    'const config = JSON.parse(await tools.read({ path: "config.json" }))',
    "console.log(config.port)",
    "",
    "If it fails, fix the program and run it again. Then tell me the port.",
  ].join("\n"),
  skill: "Write the release notes for the changes you made to src/app.js in this session.",
};

type Body = {
  type: string;
  isFailure?: boolean;
  result?: unknown;
  name?: string;
  parts?: { type: string; params?: Record<string, unknown> }[];
  tokens?: { cacheRead?: number };
};

type Turn = { answer: string; error: string; exitCode: number | null; bodies: Body[] };
type Grade = { pass: boolean; detail: string };

const sessionsDb = () => new Database(join(homedir(), ".tau/sessions.db"), { readonly: true });

const lastNumber = (session: string | undefined) => {
  if (session === undefined) return 0;
  const db = sessionsDb();
  const row = db
    .query("SELECT COALESCE(MAX(number), 0) AS last FROM entry WHERE session_id = ?")
    .get(session) as { last: number };
  db.close();
  return row.last;
};

const bodiesAfter = (session: string, after: number): Body[] => {
  const db = sessionsDb();
  const rows = db
    .query("SELECT body FROM entry WHERE session_id = ? AND number > ? ORDER BY number")
    .all(session, after) as { body: string }[];
  db.close();
  return rows.map((row) => JSON.parse(row.body) as Body);
};

const run = (command: string[], cwd: string) => {
  const done = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  if (done.exitCode !== 0) throw new Error(`${command.join(" ")} failed:\n${done.stderr.toString()}`);
};

const makeFixture = (directory: string) => {
  rmSync(directory, { recursive: true, force: true });

  for (const [path, text] of Object.entries(FIXTURE)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  }

  run(["git", "init", "-q"], directory);
  run(["git", "add", "."], directory);
  const identity = ["-c", "user.name=check", "-c", "user.email=check@example.com", "-c", "commit.gpgsign=false"];
  run(["git", ...identity, "commit", "-qm", "start"], directory);
};

const sendPrompt = async (model: string, directory: string, session: string | undefined, text: string) => {
  const before = lastNumber(session);
  const args = [BINARY, "-p", "--model", model, ...(session ? ["--session", session] : []), text];
  const child = Bun.spawn(args, { cwd: directory, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), PROMPT_TIMEOUT_MS);
  const [answer, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const exitCode = await child.exited;
  clearTimeout(timer);

  const id = session ?? /Session: (\S+)/.exec(error)?.[1];
  const turn: Turn = { answer, error, exitCode, bodies: id === undefined ? [] : bodiesAfter(id, before) };
  return { id, turn };
};

const toolResults = (turn: Turn) => turn.bodies.filter((body) => body.type === "tool-result");
const toolCalls = (turn: Turn) =>
  turn.bodies.flatMap((body) => (body.type === "assistant" ? (body.parts ?? []) : [])).filter((part) => part.type === "tool-call");

const ended = (turn: Turn): Grade | undefined =>
  turn.exitCode === 0 ? undefined : { pass: false, detail: `exit ${turn.exitCode}: ${turn.error.trim().split("\n").slice(-3).join(" ")}` };

const gradeTools = (turn: Turn): Grade => {
  const failed = ended(turn);
  if (failed) return failed;
  const passedRun = toolResults(turn).some((result) => result.isFailure === false);
  const pass = passedRun && turn.answer.includes(VERSION) && turn.answer.includes("greetVisitor");
  return { pass, detail: pass ? "" : `answer: ${turn.answer.trim().slice(0, 200)}` };
};

const gradeAgents = (turn: Turn): Grade =>
  turn.answer.includes(AGENTS_LINE)
    ? { pass: true, detail: "" }
    : { pass: false, detail: "first answer lacks the src/AGENTS.md line" };

const gradeEdits = (turn: Turn, directory: string): Grade => {
  const failed = ended(turn);
  if (failed) return failed;
  const app = readFileSync(join(directory, "src/app.js"), "utf8");
  const pass = !app.includes("greetVisitor") && app.split("welcomeVisitor").length === 4 && app.includes("`Welcome, ${name}!`");
  return { pass, detail: pass ? "" : `src/app.js: ${JSON.stringify(app)}` };
};

const gradeScriptFix = (turn: Turn): Grade & { usedEdits: boolean } => {
  const usedEdits = toolCalls(turn).some((call) => call.params?.scriptId !== undefined);
  const failed = ended(turn);
  if (failed) return { ...failed, usedEdits };
  const results = toolResults(turn);
  const failedFirst = results[0]?.isFailure === true;
  const fixed = results.some((result) => result.isFailure === false && String(result.result).includes("8080"));
  const pass = failedFirst && fixed && turn.answer.includes("8080");
  return { pass, usedEdits, detail: pass ? "" : `first failed: ${failedFirst}, fixed: ${fixed}` };
};

const gradeSkill = (turn: Turn, directory: string): Grade => {
  const failed = ended(turn);
  if (failed) return failed;
  const usedSkill = toolCalls(turn).some((call) => String(call.params?.code ?? "").includes("skills"));
  const path = join(directory, "RELEASE.md");
  const notes = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
  const pass = usedSkill && notes.startsWith(`## ${VERSION}`) && notes.endsWith(SIGNATURE);
  return { pass, detail: pass ? "" : `skill called: ${usedSkill}, RELEASE.md: ${JSON.stringify(notes.slice(0, 200))}` };
};

/** Cache reads of every model call after the first, which repeats the start of the one before. */
const cacheRead = (turns: Turn[]) =>
  turns
    .flatMap((turn) => turn.bodies)
    .filter((body) => body.type === "assistant")
    .slice(1)
    .reduce((sum, body) => sum + (body.tokens?.cacheRead ?? 0), 0);

const checkModel = async (model: string) => {
  const directory = join(HERE, "work", model.replaceAll("/", "__"));
  makeFixture(directory);
  const turns: Turn[] = [];
  let session: string | undefined;

  for (const text of Object.values(PROMPTS)) {
    const sent = await sendPrompt(model, directory, session, text);
    session = sent.id;
    turns.push(sent.turn);
    if (session === undefined) break;
  }

  const [tools, edits, scriptFix, skill] = turns;
  const missing: Grade = { pass: false, detail: "not run" };
  const fix = scriptFix ? gradeScriptFix(scriptFix) : { ...missing, usedEdits: false };

  return {
    model,
    session,
    tools: tools ? gradeTools(tools) : missing,
    agents: tools ? gradeAgents(tools) : missing,
    edits: edits ? gradeEdits(edits, directory) : missing,
    scriptFix: fix,
    usedScriptEdits: fix.usedEdits,
    skill: skill ? gradeSkill(skill, directory) : missing,
    cacheReadTokens: cacheRead(turns),
  };
};

const mark = (grade: Grade) => (grade.pass ? "pass" : "FAIL");

const models = process.argv.length > 2 ? process.argv.slice(2) : MATRIX;
console.log(`Building ${BINARY}`);
run(["bun", "build", "--compile", "src/cli/main.ts", "--outfile", BINARY], ROOT);

const report = [];

for (const model of models) {
  console.log(`\n${model}`);
  const result = await checkModel(model);
  report.push(result);
  writeFileSync(join(HERE, "results.json"), `${JSON.stringify(report, null, 2)}\n`);

  for (const key of ["tools", "agents", "edits", "scriptFix", "skill"] as const) {
    const grade = result[key];
    console.log(`  ${key}: ${mark(grade)}${grade.detail ? ` (${grade.detail})` : ""}`);
  }

  console.log(`  script edits used: ${result.usedScriptEdits}, cache read: ${result.cacheReadTokens}`);
}

console.log("\n| Model | Tools | AGENTS.md | Edits | Script fix | Fixed with edits | Skill | Cache read |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");

for (const r of report) {
  console.log(
    `| \`${r.model}\` | ${mark(r.tools)} | ${mark(r.agents)} | ${mark(r.edits)} | ${mark(r.scriptFix)} | ${r.usedScriptEdits ? "yes" : "no"} | ${mark(r.skill)} | ${r.cacheReadTokens} |`,
  );
}
