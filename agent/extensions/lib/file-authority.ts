import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandPath, resolveToCwd } from "./path-utils.ts";
import { isEnvFileName } from "../block-env-reads.ts";

// Search traversal exclusions are not file-tool permissions.
const SKIP_DIRS = new Set([
	".git", ".pi", ".agents", ".aws", ".ssh", ".gnupg", ".kube", "node_modules", "node_modules_pi", "bower_components", "site-packages", "vendor", ".venv", "venv",
	"__pycache__", ".next", ".nuxt", ".cache", ".turbo", ".tox", ".mypy_cache", "dist", "build", "out", "coverage", "target", ".terraform",
]);
const SENSITIVE_DIRS = new Set([".aws", ".ssh", ".gnupg", ".kube"]);
const DENIED_FILES = new Set([
	"auth.json", "credentials.json", "credential.json", "secrets.json", "secret.json", ".npmrc", ".pypirc",
	".netrc", ".git-credentials", "credentials", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "known_hosts",
]);
const PRIVATE_KEY = /\.(?:pem|key|p12|pfx|jks|keystore|asc|gpg|age)$/i;
const CREDENTIAL_DATA = /(?:^|[._-])(?:auth|credentials?|secrets?|tokens?)(?:[._-]|$)/i;
const DATA_EXTENSION = /\.(?:json|ya?ml|toml|ini|cfg|conf|properties|txt|csv|xml|db|sqlite3?)$/i;
const CONTROL = /[\x00-\x1f\x7f]/;

export function deniedName(name: string, directory: boolean): boolean {
	const lower = name.toLowerCase();
	return CONTROL.test(name) || lower === ".git" || (directory
		? SENSITIVE_DIRS.has(lower)
		: isEnvFileName(name) || DENIED_FILES.has(lower) || PRIVATE_KEY.test(name) || (CREDENTIAL_DATA.test(name) && DATA_EXTENSION.test(name)));
}

export function skipDirectory(name: string): boolean {
	return SKIP_DIRS.has(name.toLowerCase());
}

export function contained(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Both file tools and search reject protected cwd components, including canonical aliases. */
export function protectedCwd(cwd: string, canonical: string): boolean {
	return [cwd, path.resolve(cwd), canonical].some((location) => location.split(path.sep).some((part) =>
		part.toLowerCase() === ".git" || SENSITIVE_DIRS.has(part.toLowerCase())));
}

// The extension's location is trusted; neither cwd nor a caller-supplied path chooses the installation.
const agentDir = fileURLToPath(new URL("../../", import.meta.url));
export const installationRoot = () => realpath(agentDir);

/** Lexical control paths and their existing canonical aliases; resolve once per operation. */
export async function controlStateRoots(installation: string): Promise<string[]> {
	const roots = [
		...[agentDir, installation].flatMap((base) => ["sessions", "missions", "trust.json", ".pi-subagents"].map((name) => path.join(base, name))),
		...[path.dirname(agentDir), path.dirname(installation)].flatMap((parent) => [
			path.join(parent, ".pi-subagents"),
			...(path.basename(parent).toLowerCase() === ".pi" ? [path.join(parent, "trust.json")] : []),
		]),
	];
	return [...new Set((await Promise.all(roots.map(async (root) => [
		root, await realpath(root).catch(() => root),
	]))).flat())];
}

/** Control state is never eligible for headless search, even through a configured alias. */
export function isControlState(target: string, roots: readonly string[]): boolean {
	return target.split(path.sep).some((part) => part.toLowerCase() === ".pi-subagents") ||
		roots.some((root) => contained(root, target));
}

const installDocs = path.join(agentDir, "extensions/node_modules_pi");
const readRoots = [path.join(agentDir, "skills"), installDocs];
const readFiles = [path.join(agentDir, "GUARDRAILS.md"), path.join(agentDir, "SYSTEM.md")];
const protectedDirs = new Set(["extensions", "bin", "agents", "skills", "npm", "git", "node_modules_pi", "sessions", "missions"]);
const protectedFiles = new Set(["system.md", "append_system.md", "agents.override.md", "agents.md", "claude.md", "settings.json", "models.json", "models-store.json", "presets.json", "trust.json", "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"]);

function installedParts(target: string, installation: string): string[] {
	return contained(installation, target) ? path.relative(installation, target).split(path.sep) : [];
}

/** Exclude nested Pi configuration, not the installation's own .pi ancestor or a trusted read root. */
export function nestedConfigPath(target: string, installation: string, trustedRoot?: string): boolean {
	const configParts = installedParts(target, installation);
	const piRoot = path.dirname(installation);
	const activePiRoot = path.basename(piRoot).toLowerCase() === ".pi" && contained(piRoot, target);
	const activePiParts = activePiRoot ? path.relative(piRoot, target).split(path.sep) : [];
	const scopedParts = configParts.length ? configParts : activePiRoot
		? activePiParts
		: trustedRoot && contained(trustedRoot, target)
			? path.relative(trustedRoot, target).split(path.sep) : target.split(path.sep);
	return scopedParts.some((part) => part.toLowerCase() === ".pi" || part.toLowerCase() === ".agents");
}

/** Only these exact installed files and explicitly rooted skill/package aliases are trusted reads. */
async function trustedRead(target: string, installation: string): Promise<{ base: string; root: string } | undefined> {
	for (const candidate of readRoots) {
		let root: string;
		try { root = await realpath(candidate); } catch { continue; }
		if (contained(candidate, target)) return { base: candidate, root };
		if (contained(root, target)) return { base: root, root };
	}
	for (const file of readFiles) {
		const canonical = path.join(installation, path.basename(file));
		if (target === file || target === canonical) {
			const base = path.dirname(target);
			return { base, root: await realpath(base) };
		}
	}
	return undefined;
}

function protectedInstallation(target: string, installation: string): boolean {
	const parts = installedParts(target, installation);
	return protectedDirs.has(parts[0]?.toLowerCase()) ||
		(parts.length === 1 && protectedFiles.has(parts[0].toLowerCase()));
}

type FileTool = "read" | "edit" | "write";
export type FileDecision =
	| { kind: "deny"; reason: string }
	| { kind: "allow" | "confirm"; target: string };

const deny = (reason: string): FileDecision => ({ kind: "deny", reason: `File authority denied: ${reason}` });

/** Check names and filesystem components before any UI. Only write may create missing components. */
export async function fileAuthority(tool: FileTool, value: unknown, cwd: string): Promise<FileDecision> {
	if (typeof value !== "string" || !value || CONTROL.test(value)) return deny("invalid path");
	try {
		// Check original components before normalization can collapse restricted/.. segments.
		// fileURLToPath decodes escapes after URL parsing, which can also collapse dot segments.
		const rawParts = [value, ...(/^@?file:\/\//.test(value) ? [decodeURIComponent(value)] : []), expandPath(value)]
			.flatMap((candidate) => candidate.split(/[\\/]/).filter(Boolean));
		if (rawParts.some((part) => deniedName(part, true) || deniedName(part, false))) return deny("restricted name");
		const workingPath = path.resolve(cwd);
		const workingRoot = await realpath(workingPath);
		if (protectedCwd(cwd, workingRoot)) return deny("working directory inside restricted directory");
		const target = resolveToCwd(value, cwd);
		const installation = await installationRoot();
		const trusted = tool === "read" ? await trustedRead(target, installation) : undefined;
		// A configured read-root alias is the only symlink permitted at the root;
		// descendant components are still checked with lstat below.
		if (workingRoot !== workingPath && !(tool === "read" && trusted &&
			trusted.base !== trusted.root && contained(trusted.base, workingPath) && contained(trusted.root, workingRoot))) {
			return deny("symbolic-link working directory");
		}
		const inCwd = contained(workingPath, target);
		const base = trusted?.base ?? (inCwd ? workingPath : path.parse(target).root);
		const root = trusted?.root ?? (inCwd ? workingRoot : base);
		let resolved = root;
		let probe = base;
		let missing = false;
		const parts = path.relative(base, target).split(path.sep).filter(Boolean);
		if (!parts.length) return deny("regular file required");
		for (const [index, part] of parts.entries()) {
			if (deniedName(part, true) || deniedName(part, false)) return deny("restricted name");
			probe = path.join(probe, part);
			resolved = path.join(resolved, part);
			if (missing) continue;
			let stat;
			try { stat = await lstat(probe); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				if (tool !== "write") return deny("missing file");
				missing = true;
				continue;
			}
			if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) {
				return deny("symbolic link, hard link or nonregular file");
			}
			if (index < parts.length - 1 && !stat.isDirectory()) return deny("non-directory ancestor");
			const canonical = await realpath(probe);
			if (!contained(root, canonical)) return deny("path escapes approved root");
			resolved = canonical;
			if (index === parts.length - 1 && !stat.isFile()) return deny("regular file required");
		}
		// Keep the installed-package and protected-directory aliases canonical:
		// a cwd already inside a resolved package root must still require consent.
		const packageRoot = await realpath(installDocs).catch(() => undefined);
		const protectedAliases = await Promise.all([...protectedDirs].map((name) =>
			realpath(path.join(agentDir, name)).catch(() => undefined)));
		const controlRoots = await controlStateRoots(installation);
		const protectedRuntime = protectedInstallation(resolved, installation) ||
			(packageRoot !== undefined && contained(packageRoot, resolved)) ||
			protectedAliases.some((alias) => alias !== undefined && contained(alias, resolved));
		const nestedConfig = nestedConfigPath(resolved, installation, trusted?.root);
		if (tool === "read" && nestedConfig) return deny("nested Pi configuration read");
		const consent = (!inCwd && !trusted) || (tool !== "read" && (protectedRuntime || nestedConfig)) ||
			isControlState(resolved, controlRoots);
		return { kind: consent ? "confirm" : "allow", target };
	} catch {
		return deny("path cannot be validated");
	}
}
