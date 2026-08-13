import { parse } from "unbash";
import type { ArithmeticExpression, Command, Node, ParsedScript, Redirect, Word, WordPart } from "unbash";

const ALWAYS_SKIP = new Set([
	"cat",
	"head",
	"tail",
	"wc",
	"ls",
	"tree",
	"pwd",
	"echo",
	"printf",
	"true",
	"false",
	"test",
	"[",
	"grep",
	"egrep",
	"fgrep",
	"cut",
	"tr",
	"uniq",
	"comm",
	"cmp",
	"paste",
	"join",
	"column",
	"fmt",
	"fold",
	"nl",
	"rev",
	"tac",
	"expand",
	"unexpand",
	"tsort",
	"pr",
	"seq",
	"expr",
	"getconf",
	"id",
	"whoami",
	"uname",
	"printenv",
	"type",
	"which",
	"dirname",
	"basename",
	"readlink",
	"realpath",
	"file",
	"stat",
	"du",
	"df",
	"diff",
	"md5sum",
	"sha1sum",
	"sha256sum",
	"shasum",
	"ps",
	"uptime",
	"sleep",
	"cd",
	"bat",
	"jq",
]);

const FIND_VETO = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fls", "-fprint", "-fprint0", "-fprintf"]);

const GIT_READ_VERBS = new Set([
	"status",
	"log",
	"diff",
	"show",
	"blame",
	"rev-parse",
	"describe",
	"ls-files",
	"ls-tree",
	"cat-file",
	"rev-list",
	"name-rev",
	"merge-base",
	"reflog",
	"grep",
	"for-each-ref",
	"shortlog",
	"version",
	"help",
	"count-objects",
	"whatchanged",
	"cherry",
	"range-diff",
	"var",
]);

const WRITE_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);
const SED_PRINT = /^(?:\d+|\d+,\d+)p$/;

interface WalkState {
	sawCd: boolean;
	sawGit: boolean;
}

export function isAllowlistedBash(command: string): boolean {
	if (!command.trim()) return false;
	let script: ParsedScript;
	try {
		script = parse(command);
	} catch {
		return false;
	}
	const state: WalkState = { sawCd: false, sawGit: false };
	return walkScript(script, state) && !(state.sawCd && state.sawGit);
}

function walkScript(script: ParsedScript, state: WalkState): boolean {
	if (script.errors && script.errors.length > 0) return false;
	if (script.shebang) return false;
	if (script.commands.length === 0) return false;
	return script.commands.every((statement) => walkNode(statement, state));
}

function walkNode(node: Node, state: WalkState): boolean {
	switch (node.type) {
		case "Statement":
			if (node.background) return false;
			return walkRedirects(node.redirects, state) && walkNode(node.command, state);
		case "Command":
			return walkCommand(node, state);
		case "Pipeline":
			if (node.time || node.negated) return false;
			if (node.operators.includes("|&")) return false;
			return node.commands.every((child) => walkNode(child, state));
		case "AndOr":
			return node.commands.every((child) => walkNode(child, state));
		case "CompoundList":
			return node.commands.every((child) => walkNode(child, state));
		default:
			return false;
	}
}

function walkCommand(command: Command, state: WalkState): boolean {
	if (command.prefix.length > 0) return false;
	if (!command.name) return false;
	if (!walkRedirects(command.redirects, state)) return false;
	if (!walkWord(command.name, state)) return false;
	if (!command.suffix.every((word) => walkWord(word, state))) return false;

	const name = staticBareName(command.name);
	if (!name) return false;
	if (name === "cd") state.sawCd = true;
	if (name === "git") state.sawGit = true;
	if (state.sawCd && state.sawGit) return false;
	if (ALWAYS_SKIP.has(name)) return true;

	const args: string[] = [];
	for (const word of command.suffix) {
		const value = staticWordValue(word);
		if (value === undefined) return false;
		args.push(value);
	}

	switch (name) {
		case "find":
			return !args.some((arg) => FIND_VETO.has(arg));
		case "fd":
			return !hasFdVeto(args);
		case "rg":
			return !hasRgVeto(args);
		case "sort":
		case "base64":
		case "iconv":
			return !hasOutputFlag(args);
		case "xxd":
			return !hasShortOption(args, "r") && !hasLongOption(args, "revert");
		case "yq":
			return !hasYqInplace(args);
		case "sed":
			return isSafeSed(args);
		case "hostname":
			return !hasPositional(args);
		case "date":
			return !hasShortOption(args, "s") && !hasLongOption(args, "set");
		case "git":
			return isSafeGit(args);
		default:
			return false;
	}
}

function walkRedirects(redirects: Redirect[], state: WalkState): boolean {
	for (const redirect of redirects) {
		if (redirect.target && !walkWord(redirect.target, state)) return false;
		if (redirect.body && !walkWord(redirect.body, state)) return false;
		if (WRITE_REDIRECTS.has(redirect.operator)) {
			if (!redirect.target || staticWordValue(redirect.target) !== "/dev/null") return false;
			continue;
		}
		if (redirect.operator === ">&" || redirect.operator === "<&") {
			const target = redirect.target ? staticWordValue(redirect.target) : undefined;
			if (target === "1" || target === "2" || target === "-") continue;
			if (redirect.operator === "<&" && target === "0") continue;
			return false;
		}
		if (
			redirect.operator !== "<" &&
			redirect.operator !== "<<" &&
			redirect.operator !== "<<-" &&
			redirect.operator !== "<<<"
		) {
			return false;
		}
	}
	return true;
}

function walkWord(word: Word, state: WalkState): boolean {
	const parts = word.parts;
	if (!parts) return true;
	return parts.every((part) => walkPart(part, state));
}

function walkPart(part: WordPart, state: WalkState): boolean {
	switch (part.type) {
		case "Literal":
		case "SingleQuoted":
		case "AnsiCQuoted":
		case "SimpleExpansion":
			return true;
		case "DoubleQuoted":
		case "LocaleString":
			return part.parts.every((child) => walkPart(child, state));
		case "ParameterExpansion":
			if (part.indexParts && !part.indexParts.every((child) => walkPart(child, state))) return false;
			if (part.operand && !walkWord(part.operand, state)) return false;
			if (part.slice) {
				if (!walkWord(part.slice.offset, state)) return false;
				if (part.slice.length && !walkWord(part.slice.length, state)) return false;
			}
			if (part.replace) {
				if (!walkWord(part.replace.pattern, state)) return false;
				if (!walkWord(part.replace.replacement, state)) return false;
			}
			return true;
		case "CommandExpansion":
			return walkNestedScript(part.script, state);
		case "ProcessSubstitution":
			return false;
		case "ArithmeticExpansion":
			return part.expression ? walkArithmetic(part.expression, state) : false;
		case "ExtendedGlob":
		case "BraceExpansion":
			return !part.parts || part.parts.every((child) => walkPart(child, state));
	}
}

function walkArithmetic(expression: ArithmeticExpression, state: WalkState): boolean {
	switch (expression.type) {
		case "ArithmeticBinary":
			return walkArithmetic(expression.left, state) && walkArithmetic(expression.right, state);
		case "ArithmeticUnary":
			return walkArithmetic(expression.operand, state);
		case "ArithmeticTernary":
			return (
				walkArithmetic(expression.test, state) &&
				walkArithmetic(expression.consequent, state) &&
				walkArithmetic(expression.alternate, state)
			);
		case "ArithmeticGroup":
			return walkArithmetic(expression.expression, state);
		case "ArithmeticWord": {
			const parts = expression.parts;
			return !parts || parts.every((part) => walkPart(part, state));
		}
		case "ArithmeticCommandExpansion":
			return walkNestedScript(expression.script, state);
	}
}

function walkNestedScript(script: ParsedScript | undefined, state: WalkState): boolean {
	if (!script) return false;
	return walkScript(script, state);
}

function staticBareName(word: Word): string | undefined {
	const value = staticWordValue(word);
	if (!value || value.includes("/")) return undefined;
	return value;
}

function staticWordValue(word: Word): string | undefined {
	const parts = word.parts;
	if (!parts) return word.value;
	if (!parts.every(isStaticPart)) return undefined;
	return word.value;
}

function isStaticPart(part: WordPart): boolean {
	switch (part.type) {
		case "Literal":
		case "SingleQuoted":
		case "AnsiCQuoted":
			return true;
		case "DoubleQuoted":
		case "LocaleString":
			return part.parts.every((child) => child.type === "Literal");
		default:
			return false;
	}
}

function hasFdVeto(args: readonly string[]): boolean {
	return (
		hasShortOption(args, "x") ||
		hasShortOption(args, "X") ||
		hasLongOption(args, "exec") ||
		hasLongOption(args, "exec-batch")
	);
}

function hasRgVeto(args: readonly string[]): boolean {
	return (
		hasShortOption(args, "z") ||
		hasLongOption(args, "pre") ||
		hasLongOption(args, "hostname-bin") ||
		hasLongOption(args, "search-zip")
	);
}

function hasOutputFlag(args: readonly string[]): boolean {
	return hasShortOption(args, "o") || hasLongOption(args, "output");
}

function hasYqInplace(args: readonly string[]): boolean {
	return hasShortOption(args, "i") || hasLongOption(args, "inplace") || hasLongOption(args, "in-place");
}

function isSafeSed(args: readonly string[]): boolean {
	if (args.length < 2 || args[0] !== "-n") return false;
	const script = args[1];
	if (script === undefined || !SED_PRINT.test(script)) return false;
	for (const arg of args.slice(2)) {
		if (arg === "--") continue;
		if (arg.startsWith("-")) return false;
	}
	return true;
}

function hasPositional(args: readonly string[]): boolean {
	let endFlags = false;
	for (const arg of args) {
		if (!endFlags) {
			if (arg === "--") {
				endFlags = true;
				continue;
			}
			if (arg.startsWith("-") && arg !== "-") continue;
		}
		return true;
	}
	return false;
}

function isSafeGit(args: readonly string[]): boolean {
	if (hasGitWriteExecFlag(args)) return false;
	const verbIndex = gitVerbIndex(args);
	if (verbIndex === undefined) return false;
	const verb = args[verbIndex];
	if (verb === undefined) return false;
	const rest = args.slice(verbIndex + 1);
	if (GIT_READ_VERBS.has(verb)) return true;
	if (verb === "branch") return isGitBranch(rest);
	if (verb === "remote") return isGitRemote(rest);
	if (verb === "tag") return isGitTag(rest);
	return false;
}

function gitVerbIndex(args: readonly string[]): number | undefined {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined || arg === "--") return undefined;
		if (arg === "--no-pager" || arg === "-P" || arg === "--no-color") continue;
		if (
			arg === "-C" ||
			arg === "-c" ||
			arg === "-p" ||
			arg === "--paginate" ||
			isLongOption(arg, "config-env") ||
			isLongOption(arg, "exec-path") ||
			isLongOption(arg, "git-dir") ||
			isLongOption(arg, "work-tree") ||
			isLongOption(arg, "namespace") ||
			isLongOption(arg, "super-prefix")
		) {
			return undefined;
		}
		if (arg.startsWith("-")) return undefined;
		return index;
	}
	return undefined;
}

function hasGitWriteExecFlag(args: readonly string[]): boolean {
	for (const arg of args) {
		if (arg === "--") break;
		if (
			arg === "--paginate" ||
			isLongOption(arg, "output") ||
			isLongOption(arg, "ext-diff") ||
			isLongOption(arg, "textconv") ||
			isLongOption(arg, "exec")
		) {
			return true;
		}
	}
	return false;
}

function isGitBranch(args: readonly string[]): boolean {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined || arg === "--") return false;
		if (
			arg === "--list" ||
			arg === "--all" ||
			arg === "--remotes" ||
			arg === "--verbose" ||
			arg === "--show-current"
		) {
			continue;
		}
		if (isLongOption(arg, "format")) {
			if (arg === "--format") {
				if (args[index + 1] === undefined) return false;
				index += 1;
			}
			continue;
		}
		if (arg.startsWith("--")) return false;
		if (!arg.startsWith("-") || arg.length < 2) return false;
		for (const flag of arg.slice(1)) {
			if (flag !== "a" && flag !== "l" && flag !== "r" && flag !== "v") return false;
		}
	}
	return true;
}

function isGitRemote(args: readonly string[]): boolean {
	let index = 0;
	while (index < args.length) {
		const arg = args[index];
		if (arg !== "-v" && arg !== "--verbose") break;
		index += 1;
	}
	if (index >= args.length) return true;
	const verb = args[index];
	return verb === "show" || verb === "get-url";
}

function isGitTag(args: readonly string[]): boolean {
	let listing = false;
	for (const arg of args) {
		if (arg === "--") return false;
		if (arg === "-l" || arg === "--list") {
			listing = true;
			continue;
		}
		if (arg.startsWith("-") && !arg.startsWith("--") && arg.length > 1) {
			for (const flag of arg.slice(1)) {
				if (flag !== "l") return false;
			}
			listing = true;
			continue;
		}
		if (arg.startsWith("-") || !listing) return false;
	}
	return true;
}

function hasShortOption(args: readonly string[], letter: string): boolean {
	for (const arg of args) {
		if (arg === "--") break;
		if (arg.length < 2 || !arg.startsWith("-") || arg.startsWith("--")) continue;
		if (arg.slice(1).includes(letter)) return true;
	}
	return false;
}

function hasLongOption(args: readonly string[], name: string): boolean {
	for (const arg of args) {
		if (arg === "--") break;
		if (isLongOption(arg, name)) return true;
	}
	return false;
}

function isLongOption(arg: string, name: string): boolean {
	return arg === `--${name}` || arg.startsWith(`--${name}=`);
}
