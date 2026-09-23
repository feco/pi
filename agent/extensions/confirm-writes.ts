import path from "path";
import { homedir } from "node:os";
import { readFile, access, constants, realpath } from "node:fs/promises";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Edit validation — mirrors Pi's internal edit-diff.ts logic exactly so the
// extension can predict whether an edit will fail without importing internals.
// ---------------------------------------------------------------------------

/**
 * Normalize text for fuzzy matching.
 * Mirrors Pi's normalizeForFuzzyMatch in edit-diff.ts:
 *   - NFKC Unicode normalization
 *   - Strip trailing whitespace per line
 *   - Smart single/double quotes → ASCII
 *   - Various dashes/hyphens → ASCII hyphen
 *   - Special Unicode spaces → regular space
 */
function normalizeForFuzzyMatch(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

/** Normalize CRLF/LF to LF — mirrors Pi's normalizeToLF */
function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Strip UTF-8 BOM — mirrors Pi's stripBom */
function stripBom(content: string): string {
	return content.startsWith("\uFEFF") ? content.slice(1) : content;
}

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 * Mirrors Pi's fuzzyFindText exactly.
 */
function fuzzyFindText(
	content: string,
	oldText: string,
): { found: boolean; index: number; matchLength: number; usedFuzzyMatch: boolean; contentForReplacement: string } {
	// Try exact match first
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false, contentForReplacement: content };
	}
	// Try fuzzy match
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
	if (fuzzyIndex === -1) {
		return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false, contentForReplacement: content };
	}
	return { found: true, index: fuzzyIndex, matchLength: fuzzyOldText.length, usedFuzzyMatch: true, contentForReplacement: fuzzyContent };
}

/** Count occurrences using the same fuzzy matching as Pi's countOccurrences */
function countOccurrences(content: string, oldText: string): number {
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	return fuzzyContent.split(fuzzyOldText).length - 1;
}

/**
 * Pre-validate an edit call by mirroring Pi's applyEditsToNormalizedContent logic.
 * Returns an error message if the edit will fail, or null if it looks valid.
 */
async function validateEdit(
	filePath: string,
	edits: Array<{ oldText: string; newText: string }>,
	cwd: string,
): Promise<string | null> {
	const absolutePath = path.resolve(cwd, filePath);

	// Check if file exists
	try {
		await access(absolutePath, constants.R_OK);
	} catch {
		return `File not found: ${filePath}`;
	}

	// Read and normalize — mirrors Pi's edit tool exactly
	let content: string;
	try {
		content = await readFile(absolutePath, "utf-8");
	} catch {
		return `Cannot read file: ${filePath}`;
	}

	content = stripBom(content);
	content = normalizeToLF(content);

	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	// Check for empty oldText
	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			return normalizedEdits.length === 1
				? `oldText must not be empty in ${filePath}.`
				: `edits[${i}].oldText must not be empty in ${filePath}.`;
		}
	}

	// Run the same matching logic as Pi's applyEditsToNormalizedContent
	const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(content, edit.oldText));
	const baseContent = initialMatches.some((match) => match.usedFuzzyMatch)
		? normalizeForFuzzyMatch(content)
		: content;

	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matchResult = fuzzyFindText(baseContent, edit.oldText);

		// Not found
		if (!matchResult.found) {
			return normalizedEdits.length === 1
				? `Could not find the exact text in ${filePath}. The old text must match exactly including all whitespace and newlines.`
				: `Could not find edits[${i}] in ${filePath}. The oldText must match exactly including all whitespace and newlines.`;
		}

		// Duplicate
		const occurrences = countOccurrences(baseContent, edit.oldText);
		if (occurrences > 1) {
			return normalizedEdits.length === 1
				? `Found ${occurrences} occurrences of the text in ${filePath}. The text must be unique. Please provide more context to make it unique.`
				: `Found ${occurrences} occurrences of edits[${i}] in ${filePath}. Each oldText must be unique. Please provide more context to make it unique.`;
		}
	}

	// Check for overlap (mirrors Pi's logic)
	const matchedEdits: Array<{ editIndex: number; matchIndex: number; matchLength: number; newText: string }> = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matchResult = fuzzyFindText(baseContent, edit.oldText);
		if (!matchResult.found) continue; // already reported above
		matchedEdits.push({ editIndex: i, matchIndex: matchResult.index, matchLength: matchResult.matchLength, newText: edit.newText });
	}
	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			return `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${filePath}. Merge them into one edit or target disjoint regions.`;
		}
	}

	// Check for no-change (oldText === newText would produce identical content)
	let newContent = baseContent;
	for (let i = matchedEdits.length - 1; i >= 0; i--) {
		const edit = matchedEdits[i];
		newContent = newContent.substring(0, edit.matchIndex) + edit.newText + newContent.substring(edit.matchIndex + edit.matchLength);
	}
	if (baseContent === newContent) {
		return normalizedEdits.length === 1
			? `No changes made to ${filePath}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
			: `No changes made to ${filePath}. The replacements produced identical content.`;
	}

	return null;
}

// ---------------------------------------------------------------------------
// Exploration command auto-approval — full defense-in-depth validation
// for find, ls, grep, rg targeting allowed directories.
// ---------------------------------------------------------------------------

/** Flags known to consume the next token as a value (not a path). */
const VALUE_CONSUMING_FLAGS = new Set([
	// find options
	"-maxdepth", "-mindepth",
	// find expressions (all take a value after the flag)
	"-name", "-iname", "-path", "-ipath", "-regex", "-iregex",
	"-type", "-size", "-user", "-group", "-perm", "-links",
	"-newer", "-anewer", "-cnewer", "-Bmin", "-Btime", "-Amin", "-Atime",
	"-Cmin", "-Ctime", "-mmin", "-mtime", "-used", "-fstype",
	"-gid", "-uid", "-inum", "-samefile", "-ilname", "-lname",
	"-printf", "-fprintf", "-fprint", "-fprint0", "-fls",
	// grep options that take a value
	"--include", "--exclude", "--exclude-dir", "--include-dir",
	"-A", "-B", "-C", "-m", "--max-count", "--group-separator",
	"--color", "--colour",
	// rg options that take a value
	"-g", "--glob", "--type", "-t", "--type-not", "-T",
	"--type-add", "--type-clear",
	"-A", "-B", "-C", "-m", "--max-count",
	"--context-separator", "--field-context-separator",
]);

/** find options that are NOT expressions (don't start the expression phase). */
const FIND_OPTIONS = new Set([
	"-maxdepth", "-mindepth", "-daystart", "-mount", "-xdev",
	"-help", "-version", "-ignore_readdir_race", "-noignore_readdir_race",
	"-noleaf", "-regextype", "-warn", "-nowarn",
]);

/**
 * Tokenize a shell command string, respecting single/double quotes and backslash escapes.
 */
function tokenizeShell(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let backslash = false;

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];

		if (backslash) {
			backslash = false;
			current += ch;
			continue;
		}

		if (ch === "\\" && !inSingle) {
			backslash = true;
			continue;
		}

		if (ch === "'" && !inDouble && !backslash) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle && !backslash) {
			inDouble = !inDouble;
			continue;
		}

		if ((ch === " " || ch === "\t" || ch === "\n" || ch === "\r") && !inSingle && !inDouble) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
		} else {
			current += ch;
		}
	}
	if (current.length > 0) tokens.push(current);
	return tokens;
}

/**
 * Extract unquoted words from a shell command string.
 * Used to detect dangerous barewords like eval, source, xargs.
 */
function extractUnquotedWords(input: string): string[] {
	const words: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let backslash = false;

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];

		if (backslash) {
			backslash = false;
			current += ch;
			continue;
		}

		if (ch === "\\" && !inSingle) {
			backslash = true;
			continue;
		}

		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}

		if (inSingle || inDouble) continue; // skip quoted content entirely

		if (ch === " " || ch === "\t" || ch === "\n") {
			if (current.length > 0) {
				words.push(current);
				current = "";
			}
		} else {
			current += ch;
		}
	}
	if (current.length > 0) words.push(current);
	return words;
}

/**
 * Scan the raw command string for dangerous shell metacharacters.
 * Only checks unquoted regions — operators inside quotes are safe.
 * Returns an error reason string if dangerous, null if clean.
 */
function scanDangerousOperators(input: string): string | null {
	let inSingle = false;
	let inDouble = false;
	let backslash = false;

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];

		if (backslash) {
			backslash = false;
			continue;
		}

		if (ch === "\\" && !inSingle) {
			backslash = true;
			continue;
		}

		if (ch === "'" && !inDouble && !backslash) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle && !backslash) {
			inDouble = !inDouble;
			continue;
		}

		if (inSingle || inDouble) continue;

		// && — command chaining
		if (ch === "&" && input[i + 1] === "&") {
			return "Chaining operator '&&' detected — not allowed in auto-approved exploration commands.";
		}

		// || — command chaining
		if (ch === "|" && input[i + 1] === "|") {
			return "Chaining operator '||' detected — not allowed in auto-approved exploration commands.";
		}

		// | — pipe (but not ||)
		if (ch === "|" && input[i + 1] !== "|") {
			return "Pipe operator '|' detected — not allowed in auto-approved exploration commands.";
		}

		// ; — command separator
		if (ch === ";") {
			return "Command separator ';' detected — not allowed in auto-approved exploration commands.";
		}

		// \n, \r — newline command separators (equivalent to ; in bash)
		if (ch === "\n" || ch === "\r") {
			return "Command separator '\\n' detected — not allowed in auto-approved exploration commands.";
		}

		// & — background execution (but not &&)
		if (ch === "&" && input[i + 1] !== "&" && (i === 0 || input[i - 1] !== "&")) {
			return "Background operator '&' detected — not allowed in auto-approved exploration commands.";
		}

		// $( — command substitution
		if (ch === "$" && input[i + 1] === "(") {
			return "Command substitution '$(' detected — not allowed in auto-approved exploration commands.";
		}

		// ` — backtick command substitution
		if (ch === "`") {
			return "Backtick command substitution detected — not allowed in auto-approved exploration commands.";
		}

		// ( — subshell (but not $( which is caught above)
		if (ch === "(" && (i === 0 || input[i - 1] !== "$")) {
			return "Subshell '(' detected — not allowed in auto-approved exploration commands.";
		}

		// > and >> — output redirect
		if (ch === ">") {
			return "Redirect '>' detected — not allowed in auto-approved exploration commands.";
		}

		// < and <<< — input redirect / here-string
		if (ch === "<") {
			return "Redirect '<' detected — not allowed in auto-approved exploration commands.";
		}
	}

	// Word-level checks for dangerous barewords (eval, source, ., xargs)
	// Note: '.' is only dangerous as the first word (dot-source command);
	// as a path argument (e.g. 'find . -name *.ts') it is safe.
	const words = extractUnquotedWords(input);
	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		if (word === "eval") {
			return "'eval' detected — not allowed in auto-approved exploration commands.";
		}
		if (word === "source") {
			return "'source' detected — not allowed in auto-approved exploration commands.";
		}
		if (word === "." && i === 0) {
			return "Dot-source '.' detected — not allowed in auto-approved exploration commands.";
		}
		if (word === "xargs") {
			return "'xargs' detected — not allowed in auto-approved exploration commands.";
		}
	}

	return null;
}

/**
 * Check tokenized command for dangerous flags.
 * Returns an error reason string if dangerous, null if clean.
 */
function checkDangerousFlags(tokens: string[], cmd: string): string | null {
	for (const token of tokens) {
		// find: -exec, -execdir, -ok, -okdir — execute arbitrary commands
		// -delete — deletes files, destructive
		if (cmd === "find") {
			if (token === "-exec" || token === "-execdir" || token === "-ok" || token === "-okdir" || token === "-delete") {
				return `Dangerous flag '${token}' on find — executes arbitrary commands or deletes files, not allowed in auto-approved exploration.`;
			}
		}

		// rg: --exec, --replace, -I, -i — invoke external commands (xargs-like)
		if (cmd === "rg") {
			if (token === "--exec" || token === "--replace") {
				return `Dangerous flag '${token}' on rg — invokes external commands, not allowed in auto-approved exploration.`;
			}
			if (token === "-I" || token === "-i") {
				return `Dangerous flag '${token}' on rg — invokes external commands (like --replace), not allowed.`;
			}
		}

		// Symlink following: -L, -follow, --follow (find, ls, rg only — grep's -L means "files without match")
		if (cmd !== "grep" && (token === "-L" || token === "-follow" || token === "--follow")) {
			return `Symlink-following flag '${token}' detected — symlinks may escape allowed directories, not allowed in auto-approved exploration.`;
		}
	}

	return null;
}

/**
 * Extract path arguments from a tokenized exploration command.
 * Handles -- separator, - as stdin, grep/rg pattern skipping,
 * find option/expression phases, and flag value consumption.
 */
function extractPaths(tokens: string[], cmd: string): string[] {
	const paths: string[] = [];
	let pastDashDash = false;
	let skipNext = false;
	let pastPattern = false;
	let findExpressionStarted = false;

	// rg --files mode: no pattern, all non-flag tokens are paths
	const hasFilesFlag = tokens.includes("--files");
	if (cmd === "rg" && hasFilesFlag) {
		pastPattern = true;
	}

	for (let i = 1; i < tokens.length; i++) {
		const token = tokens[i];

		if (skipNext) {
			skipNext = false;
			continue;
		}

		// -- ends options; everything after is a path
		if (token === "--") {
			pastDashDash = true;
			continue;
		}

		if (pastDashDash) {
			// "-" means stdin/stdout, not a file path — allow
			if (token !== "-") paths.push(token);
			continue;
		}

		// Flags that consume the next token as a value
		if (token.startsWith("-") && VALUE_CONSUMING_FLAGS.has(token)) {
			skipNext = true;
			continue;
		}

		// Other flags (boolean flags, or =value form like --include=*.ts)
		if (token.startsWith("-")) {
			if (cmd === "find" && !FIND_OPTIONS.has(token)) {
				findExpressionStarted = true;
			}
			continue;
		}

		// Non-flag token
		if (cmd === "grep" || cmd === "rg") {
			if (!pastPattern) {
				pastPattern = true;
				continue; // this is the pattern, not a path
			}
			if (token !== "-") paths.push(token);
		} else if (cmd === "find") {
			if (!findExpressionStarted) {
				if (token !== "-") paths.push(token);
			}
			// After expression starts, non-flag tokens are expression values — skip
		} else if (cmd === "ls") {
			if (token !== "-") paths.push(token);
		}
	}

	// No paths found — default to cwd
	if (paths.length === 0) {
		paths.push(".");
	}

	return paths;
}

/**
 * Full defense-in-depth validation for exploration commands (find, ls, grep, rg).
 * Checks: command identity, chaining operators, subshells, dangerous flags,
 * path traversal, and validates all target paths are within allowed directories.
 *
 * Allowed directories: cwd, /tmp, pi node_modules.
 */
function isSafeExplorationCommand(
	command: string,
	cwd: string,
): { safe: boolean; reason?: string } {
	const trimmed = command.trimStart();

	// 1. Must start with an allowed command (no leading env vars, sudo, etc.)
	const cmdMatch = /^(?:find|ls|grep|rg)\b/.exec(trimmed);
	if (!cmdMatch) {
		return {
			safe: false,
			reason:
				"Command does not start with an allowed exploration tool (find, ls, grep, rg).",
		};
	}
	const cmd = cmdMatch[0];

	// 2. Scan for dangerous shell metacharacters in unquoted regions
	const opReason = scanDangerousOperators(command);
	if (opReason) {
		return { safe: false, reason: opReason };
	}

	// 3. Tokenize and check for dangerous flags
	const tokens = tokenizeShell(command);
	const flagReason = checkDangerousFlags(tokens, cmd);
	if (flagReason) {
		return { safe: false, reason: flagReason };
	}

	// 4. Extract path arguments
	const paths = extractPaths(tokens, cmd);

	// 5. Validate every path resolves inside an allowed root
	const allowedRoots = [
		cwd,
		"/tmp",
		path.resolve(
			homedir(),
			".nvm/versions/node/v22.22.3/lib/node_modules/@earendil-works",
		),
	];

	for (const p of paths) {
		// "-" means stdin/stdout, not a file path — allow
		if (p === "-") continue;

		// Block ".." path traversal segments
		if (p.split(path.sep).some((seg) => seg === "..")) {
			return {
				safe: false,
				reason: `Path "${p}" contains ".." traversal — not allowed in auto-approved exploration.`,
			};
		}

		const resolved = path.resolve(cwd, p);
		const allowed = allowedRoots.some(
			(root) => resolved === root || resolved.startsWith(root + path.sep),
		);
		if (!allowed) {
			return {
				safe: false,
				reason:
					`Path "${p}" resolves to "${resolved}" which is outside allowed directories (cwd, /tmp, pi node_modules).`,
			};
		}
	}

	return { safe: true };
}

/** Resolve existing symlinked ancestors before auto-approving a write. */
async function resolvesInsideCwd(filePath: string, cwd: string): Promise<boolean> {
	let root: string;
	try {
		root = await realpath(cwd);
	} catch {
		return false;
	}

	const target = path.resolve(cwd, filePath);
	let probe = target;
	let resolvedProbe: string;

	while (true) {
		try {
			resolvedProbe = await realpath(probe);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
			const parent = path.dirname(probe);
			if (parent === probe) return false;
			probe = parent;
		}
	}

	const resolvedTarget = path.resolve(resolvedProbe, path.relative(probe, target));
	const relative = path.relative(root, resolvedTarget);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

// ---------------------------------------------------------------------------
// Azure DevOps read classification
// ---------------------------------------------------------------------------

const AZURE_DEVOPS_READ_TOOLS = new Set([
	"mcp_azure_devops_core_list_projects",
	"mcp_azure_devops_core_list_project_teams",
	"mcp_azure_devops_core_get_identity_ids",
]);

const AZURE_DEVOPS_READ_ACTIONS = new Map<string, Set<string>>([
	["mcp_azure_devops_work", new Set([
		"list_iterations",
		"list_team_iterations",
		"get_team_settings",
		"get_team_capacity",
		"get_iteration_capacities",
	])],
	["mcp_azure_devops_wit_work_item", new Set([
		"get",
		"get_batch",
		"list_comments",
		"my",
		"list_revisions",
		"list_for_iteration",
		"get_type",
	])],
	["mcp_azure_devops_wit_query", new Set(["get", "get_results", "wiql"])],
	["mcp_azure_devops_wit_backlog", new Set(["list", "list_work_items"])],
	["mcp_azure_devops_repo_repository", new Set(["get", "list"])],
	["mcp_azure_devops_repo_pull_request", new Set(["get", "list", "list_by_commits"])],
	["mcp_azure_devops_repo_pull_request_org", new Set()],
	["mcp_azure_devops_repo_pull_request_thread", new Set(["list", "list_comments"])],
	["mcp_azure_devops_repo_branch", new Set(["get", "list", "list_mine"])],
	["mcp_azure_devops_repo_file", new Set(["get_content", "list_directory"])],
	["mcp_azure_devops_repo_search_commits", new Set()],
]);

export function isReadOnlyAzureDevOpsCall(toolName: string, input: unknown): boolean {
	if (AZURE_DEVOPS_READ_TOOLS.has(toolName)) return true;
	if (typeof input !== "object" || input === null) return false;

	if (toolName === "mcp_azure_devops_wit_work_item_attachment") {
		return (input as { savePath?: unknown }).savePath === undefined;
	}

	const allowedActions = AZURE_DEVOPS_READ_ACTIONS.get(toolName);
	if (allowedActions === undefined) return false;
	const action = (input as { action?: unknown }).action;
	if (allowedActions.size === 0) return action === undefined;
	return typeof action === "string" && allowedActions.has(action);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		// Allow read-only / internal wiki tools without confirmation
		if (
			event.toolName === "read" ||
			event.toolName === "web_fetch" ||
			event.toolName === "web_search" ||
			event.toolName.startsWith("goulven_") ||
			event.toolName === "mcp__plugin_context-mode_context-mode__ctx_search" ||
			event.toolName === "mcp__plugin_context-mode_context-mode__ctx_fetch_and_index"
		) {
			return undefined;
		}

		// Allow only explicitly classified Azure DevOps reads without confirmation.
		// Write tools, mixed-tool write actions, and future additions require confirmation.
		if (isReadOnlyAzureDevOpsCall(event.toolName, event.input)) {
			return undefined;
		}

		// Allow read-only CodeGraph tools, including MCP-namespaced variants.
		if (event.toolName === "codegraph_explore" || event.toolName.endsWith("_codegraph_explore")) {
			return undefined;
		}

		// Auto-approve edit/write paths that resolve inside cwd in every mode.
		// Outside cwd, interactive sessions fall through to confirmation while
		// headless sessions remain blocked.
		if (event.toolName === "edit" || event.toolName === "write") {
			const filePath = event.input.path as string | undefined;
			if (filePath && (await resolvesInsideCwd(filePath, ctx.cwd))) {
				return undefined;
			}
			if (!ctx.hasUI) {
				return {
					block: true,
					reason: `Blocked "${event.toolName}" outside the working directory: ${filePath ?? "(missing path)"}`,
				};
			}
		}

		// For edit tool: pre-validate. If the edit will fail (duplicate oldText,
		// file not found, etc.), skip confirmation so the agent gets immediate
		// error feedback and can retry without human involvement.
		if (event.toolName === "edit") {
			const input = event.input as { path?: string; edits?: Array<{ oldText: string; newText: string }> };
			if (input?.path && Array.isArray(input?.edits) && input.edits.length > 0) {
				const error = await validateEdit(input.path, input.edits, ctx.cwd);
				if (error) {
					// Edit will fail — skip confirmation, let agent get the error directly
					return undefined;
				}
			}
		}

		// Auto-approve exploration commands (find, ls, grep, rg) targeting
		// allowed directories: cwd, /tmp, pi node_modules.
		// Full defense-in-depth: blocks chaining, subshells, dangerous flags,
		// path traversal, and redirects.
		if (event.toolName === "bash") {
			const command: string = event.input.command ?? "";
			const tokens = tokenizeShell(command);
			const isCodeGraphExplore = tokens[0] === "codegraph" && tokens[1] === "explore";
			if (isCodeGraphExplore && !/[`$]/.test(command) && !scanDangerousOperators(command)) {
				return undefined;
			}

			const isExploration = /^(?:find|ls|grep|rg)\b/.test(command.trimStart());
			if (isExploration) {
				const result = isSafeExplorationCommand(command, ctx.cwd);
				if (result.safe) {
					return undefined;
				}
				// If unsafe, fall through to confirmation (or block if no UI)
			}
		}

		// In non-interactive mode, block anything not explicitly allowed above.
		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `Blocked "${event.toolName}" — confirmation required but no UI is available`,
			};
		}

		// Build a human-readable summary of the operation
		// Use markdown formatting (code blocks, headings) so the Pi TUI
		// renders it multi-line without truncation.
		let summary: string;
		try {
			if (event.toolName === "bash") {
				const cmd = event.input.command ?? "(unknown)";
				const timeout = event.input.timeout;
				const timeoutNote = timeout != null ? `\n**Timeout:** ${timeout}ms` : "";
				summary = `**Command:**\n\n\`\`\`sh\n${cmd}\n\`\`\`${timeoutNote}`;
			} else if (event.toolName === "write") {
				const filePath = event.input.path ?? "(unknown)";
				const content = typeof event.input.content === "string" ? event.input.content : "";
				const lines = content.split("\n");
				const previewLines = lines.slice(0, 30);
				const preview = previewLines.join("\n");
				const truncated = lines.length > 30
					? `\n\n*(+${lines.length - 30} more lines not shown)*`
					: "";
				summary = `**Path:** \`${filePath}\`\n\n**Content preview:**\n\n\`\`\`\n${preview}\n\`\`\`${truncated}`;
			} else if (event.toolName === "edit") {
				const filePath = event.input.path ?? "(unknown)";
				const edits = Array.isArray(event.input.edits) ? event.input.edits : [];
				const countNote = edits.length > 0 ? ` (${edits.length} edit${edits.length > 1 ? "s" : ""})` : "";
				summary = `**Path:** \`${filePath}\`${countNote}`;
			} else {
				// Generic: show formatted JSON with indentation for readability
				const str = JSON.stringify(event.input, null, 2);
				const maxLen = 2000;
				const display = str.length > maxLen ? str.slice(0, maxLen) + "\n\n*(truncated)*" : str;
				summary = `**Input:**\n\n\`\`\`json\n${display}\n\`\`\``;
			}
		} catch {
			summary = "*(unable to display arguments)*";
		}

		const confirmed = await ctx.ui.confirm(
			`Confirm ${event.toolName}?`,
			`The agent wants to execute:\n\n${summary}\n\nAllow this operation?`,
		);

		if (!confirmed) {
			const reason = await ctx.ui.input("Reason for blocking (optional):", "");
			return { block: true, reason: `User rejected this operation. Reason: ${reason || "(none given)"}` };
		}

		return undefined;
	});
}
