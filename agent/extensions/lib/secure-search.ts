import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { contained, controlStateRoots, deniedName, installationRoot, isControlState, nestedConfigPath, protectedCwd, skipDirectory } from "./file-authority.ts";

const MAX_DEPTH = 32;
const MAX_ENTRIES = 10_000;
const MAX_FILE_BYTES = 1_048_576;
const MAX_OUTPUT_BYTES = 65_536;
const MAX_LIMIT = 1_000;
const INCOMPLETE_WARNING = "Warning: incomplete search; one or more subtrees were skipped because an ignore policy could not be safely read.";
type Input = Record<string, unknown>;
type Kind = "grep" | "find" | "ls";
type IgnorePolicy = { base: string; matcher: Ignore };

function integer(value: unknown, fallback: number, max: number, name: string): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) throw new Error(`Invalid ${name}: expected an integer from 0 to ${max}`);
	return value as number;
}

function text(value: unknown, name: string, required = false): string | undefined {
	if (value === undefined && !required) return undefined;
	if (typeof value !== "string" || value.length > 1024 || (required && !value.length)) throw new Error(`Invalid ${name}`);
	return value;
}

function validate(input: Input, kind: Kind): void {
	const allowed = kind === "grep"
		? ["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"]
		: kind === "find" ? ["pattern", "path", "limit"] : ["path", "limit"];
	if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key))) {
		throw new Error("Unsupported search parameters");
	}
	text(input.path, "path");
	if (kind !== "ls") text(input.pattern, "pattern", true);
	if (kind === "grep") {
		text(input.glob, "glob");
		for (const name of ["ignoreCase", "literal"] as const) {
			if (input[name] !== undefined && typeof input[name] !== "boolean") throw new Error(`Invalid ${name}`);
		}
		integer(input.context, 0, 10, "context");
	}
	integer(input.limit, 100, MAX_LIMIT, "limit");
}

/** A fixed-size read, rechecking the opened inode, not just its pathname. */
async function safeRead(file: string, signal: AbortSignal): Promise<string | undefined> {
	if (signal.aborted) throw new Error("Search cancelled");
	const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) return undefined;
		const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (signal.aborted) throw new Error("Search cancelled");
		if (bytesRead > MAX_FILE_BYTES || buffer.subarray(0, bytesRead).includes(0)) return undefined;
		return buffer.toString("utf8", 0, bytesRead);
	} finally {
		await handle.close();
	}
}

/** Each policy stays relative to its own directory; deeper matching rules take precedence. */
function parseIgnore(content: string, base: string): IgnorePolicy {
	return { base, matcher: ignore({ ignorecase: false }).add(content) };
}

function ignored(relative: string, directory: boolean, policies: IgnorePolicy[]): boolean {
	let excluded = false;
	for (const policy of policies) {
		const local = path.posix.relative(policy.base || ".", relative);
		if (!local || local === ".." || local.startsWith("../")) continue;
		const result = policy.matcher.test(directory ? `${local}/` : local);
		if (result.ignored || result.unignored) excluded = result.ignored;
	}
	return excluded;
}

/** The combined policy already admitted this directory. Keep that decision in each
 * matcher so its recursive parent check cannot hide descendants after a nested exception.
 * Clone only affected matchers: reopening one branch must not change its siblings. */
function enterDirectory(relative: string, policies: IgnorePolicy[]): IgnorePolicy[] {
	return policies.map((policy) => {
		const local = path.posix.relative(policy.base || ".", relative);
		if (!local || !policy.matcher.test(`${local}/`).ignored) return policy;
		const literal = local.replace(/[\\*?[\]#! ]/g, "\\$&");
		return { base: policy.base, matcher: ignore({ ignorecase: false }).add(policy.matcher).add(`!/${literal}/`) };
	});
}

export async function secureSearch(kind: Kind, input: Input, cwd: string, signal: AbortSignal): Promise<string> {
	validate(input, kind);
	if (signal.aborted) throw new Error("Search cancelled");
	const root = await realpath(cwd);
	// Check both the supplied cwd and its canonical name BEFORE any directory traversal.
	if (protectedCwd(cwd, root) || path.resolve(cwd) !== root) throw new Error("Search denied: protected or symbolic-link working directory");
	const installation = await installationRoot();
	if (nestedConfigPath(root, installation)) throw new Error("Search denied: nested Pi configuration working directory");
	const controlRoots = await controlStateRoots(installation);
	if (isControlState(root, controlRoots)) throw new Error("Search denied: protected working directory");
	const requested = (input.path as string | undefined) || ".";
	if (requested.split(/[\\/]/).some((part) => deniedName(part, true) || deniedName(part, false))) {
		throw new Error("Search denied: restricted target");
	}
	const target = path.resolve(root, requested);
	if (!contained(root, target)) throw new Error("Search denied: outside working directory");
	if (isControlState(target, controlRoots)) throw new Error("Search denied: protected target");
	const relativeTarget = path.relative(root, target);
	// Inspect every ancestor without following a symbolic link, including the explicit target.
	let probe = root;
	for (const part of relativeTarget.split(path.sep).filter(Boolean)) {
		probe = path.join(probe, part);
		if (isControlState(probe, controlRoots)) throw new Error("Search denied: protected target");
		const stat = await lstat(probe);
		if (stat.isSymbolicLink() || deniedName(part, stat.isDirectory()) || (stat.isDirectory() && skipDirectory(part))) {
			throw new Error("Search denied: restricted or symbolic-link target");
		}
		const canonical = await realpath(probe);
		if (!contained(root, canonical) || isControlState(canonical, controlRoots)) throw new Error("Search denied: protected or outside target");
		if (!stat.isDirectory() && !stat.isFile()) throw new Error("Search denied: non-regular target");
		if (stat.isFile() && stat.nlink !== 1) throw new Error("Search denied: hard-linked target");
	}
	// An explicit ignored target must fail, rather than bypassing the directory walk.
	let ancestor = root;
	let ancestorRules: IgnorePolicy[] = [];
	for (const part of ["", ...relativeTarget.split(path.sep).filter(Boolean)]) {
		if (part) {
			ancestor = path.join(ancestor, part);
			const stat = await lstat(ancestor);
			const relative = path.relative(root, ancestor).replaceAll(path.sep, "/");
			if (ignored(relative, stat.isDirectory(), ancestorRules)) {
				throw new Error("Search denied: ignored target");
			}
			if (stat.isDirectory()) ancestorRules = enterDirectory(relative, ancestorRules);
		}
		if (!(await lstat(ancestor)).isDirectory()) continue;
		const ignorePath = path.join(ancestor, ".gitignore");
		let stat;
		try { stat = await lstat(ignorePath); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || !contained(root, await realpath(ignorePath))) {
			throw new Error("Search denied: unsafe ignore policy");
		}
		const content = await safeRead(ignorePath, signal);
		if (content === undefined) throw new Error("Search denied: unreadable ignore policy");
		ancestorRules = ancestorRules.concat(parseIgnore(content, path.relative(root, ancestor).replaceAll(path.sep, "/")));
	}
	const targetStat = await lstat(target);
	if (targetStat.isSymbolicLink() || (!targetStat.isDirectory() && (!targetStat.isFile() || targetStat.nlink !== 1))) {
		throw new Error("Search denied: non-regular or linked target");
	}
	if (kind !== "grep" && !targetStat.isDirectory()) throw new Error("Search denied: directory required");

	const limit = integer(input.limit, 100, MAX_LIMIT, "limit");
	const output: string[] = [];
	let bytes = 0;
	let visited = 0;
	let skippedPolicy = false;
	function add(line: string): boolean {
		const formatted = line.slice(0, 2048);
		if (output.length >= limit || bytes + Buffer.byteLength(formatted) + 1 > MAX_OUTPUT_BYTES - Buffer.byteLength(INCOMPLETE_WARNING) - 1) return false;
		output.push(formatted);
		bytes += Buffer.byteLength(formatted) + 1;
		return true;
	}
	const regex = kind === "grep"
		? new RegExp(input.literal ? (input.pattern as string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : input.pattern as string, input.ignoreCase ? "i" : "")
		: undefined;
	const context = integer(input.context, 0, 10, "context");
	const pattern = kind === "find" ? input.pattern as string : undefined;
	const glob = kind === "grep" ? input.glob as string | undefined : undefined;

	async function fileResult(file: string, relative: string): Promise<void> {
		if (kind !== "grep" || (glob && !path.matchesGlob(relative, glob) && !(glob.indexOf("/") < 0 && path.matchesGlob(path.basename(relative), glob)))) return;
		const content = await safeRead(file, signal);
		if (content === undefined) return;
		const lines = content.split(/\r?\n/);
		const shown = new Set<number>();
		for (let i = 0; i < lines.length && output.length < limit; i++) {
			if (!regex!.test(lines[i])) continue;
			for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) {
				if (!shown.has(j) && !add(`${relative.replaceAll(path.sep, "/")}:${j + 1}:${lines[j]}`)) return;
				shown.add(j);
			}
		}
	}

	async function walk(dir: string, relative: string, depth: number, inherited: IgnorePolicy[]): Promise<void> {
		if (signal.aborted) throw new Error("Search cancelled");
		if (depth > MAX_DEPTH || output.length >= limit) return;
		let rules = depth > 0 ? enterDirectory(relative, inherited) : inherited;
		const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"));
		const ignore = entries.find((entry) => entry.name === ".gitignore");
		if (ignore && depth > 0) {
			const ignorePath = path.join(dir, ignore.name);
			const stat = await lstat(ignorePath);
			if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || !contained(root, await realpath(ignorePath))) {
				skippedPolicy = true;
				return;
			}
			const content = await safeRead(ignorePath, signal);
			if (content === undefined) {
				skippedPolicy = true;
				return;
			}
			rules = rules.concat(parseIgnore(content, relative.replaceAll(path.sep, "/")));
		}
		for (const entry of entries) {
			if (signal.aborted) throw new Error("Search cancelled");
			if (++visited > MAX_ENTRIES || output.length >= limit) return;
			const child = path.join(dir, entry.name);
			if (isControlState(child, controlRoots)) continue;
			const rel = path.relative(root, child).replaceAll(path.sep, "/");
			// Do not trust Dirent alone: validate each descendant before matching, reading or emitting its name.
			const stat = await lstat(child);
			if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) ||
				deniedName(entry.name, stat.isDirectory()) || (stat.isDirectory() && skipDirectory(entry.name)) || ignored(rel, stat.isDirectory(), rules)) continue;
			const canonical = await realpath(child);
			if (!contained(root, canonical) || isControlState(canonical, controlRoots)) continue;
			if (kind === "ls") {
				if (depth === 0) add(`${rel}${stat.isDirectory() ? "/" : ""}`);
				continue;
			}
			if (kind === "find" && (path.matchesGlob(rel, pattern!) || (!pattern!.includes("/") && path.matchesGlob(entry.name, pattern!)))) {
				add(`${rel}${stat.isDirectory() ? "/" : ""}`);
			}
			if (stat.isDirectory()) await walk(child, rel, depth + 1, rules);
			else await fileResult(child, rel);
		}
	}

	if (targetStat.isDirectory()) await walk(target, relativeTarget.replaceAll(path.sep, "/"), 0, ancestorRules);
	else await fileResult(target, relativeTarget.replaceAll(path.sep, "/"));
	const result = output.join("\n") || (skippedPolicy ? "No results in searched files" : "No results");
	return skippedPolicy ? `${INCOMPLETE_WARNING}\n${result}` : result;
}
