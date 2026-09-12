import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { basename } from "node:path";

/**
 * Block all tool-based access to secret-bearing env files AND to the
 * host's environment variables.
 *
 * 1. ENV FILES — any `.env` variant:
 *      .env, .env.local, .env.production, prod.env, prod.env.local, …
 *    Non-secret sample files are ALLOWED:
 *      .env.example, .env.sample, .env.template, .env.dist, .env.schema
 *      (also foo.env.example, .env.production.sample, …)
 *
 *    Covers read/edit/write/ls (path), grep (path + glob), find (path +
 *    pattern), bash (path-like token scan incl. `~`, `/` and `=` boundaries,
 *    so `$HOME/.env`, `~/.env`, `f=.env` and a bare `.env` are caught),
 *    ctx_execute_file (path), ctx_execute / ctx_batch_execute (string-literal
 *    scan), ctx_index (path + auto-exclude globs so directory walks skip env
 *    files).
 *
 * 2. GLOB READS that could expand to a `.env` file:
 *    Dotfile globs (`.*`, `.en*`, `.e?v`) and env-bearing globs (`*.env`,
 *    `*env*`) are blocked with a dedicated message, because the shell expands
 *    them to `.env` without the literal token ever appearing in the command.
 *
 * 3. ENVIRONMENT VARIABLES — the OS process environment:
 *    - bash: dump commands (env, printenv, export -p, bare export, declare
 *      -p, bare declare/typeset, bare set) — incl. redirect/pipe terminators
 *      (`env > f`) and `sh -c env` / `bash -c 'env'` wrappers — plus
 *      /proc/<anything>/environ (incl. `$$`, `$BASHPID`), `ps e`, awk ENVIRON,
 *      and printing a secret-looking variable (echo/printf/cat/… $SECRET).
 *    - code (ctx_execute / ctx_execute_file): language-aware env APIs —
 *      process.env, import.meta.env, Bun.env, Deno.env, os.environ,
 *      os.getenv, Ruby ENV[], PHP $_ENV/$_SERVER/getenv, Perl %ENV/$ENV{,
 *      Rust std::env::var(s), Go os.Getenv/Environ, C# Environment.GetEnv…,
 *      Elixir System.get_env, R Sys.getenv, plus $env: (PowerShell) — AND
 *      indirect reads via /proc/<pid>/environ, quoted dump-command string
 *      literals (e.g. execSync("env"), os.system("printenv")).
 *
 * Non-secret echoes like `echo $HOME` / `echo $PATH` are allowed; only
 * variable names matching a secret keyword (TOKEN, KEY, SECRET, PASSWORD,
 * …) are blocked when printed.
 *
 * LIMITATION: this is text/pattern analysis on the command string, so deep
 * obfuscation (char-escapes like `.e''nv`, base64-decoded paths, fully
 * dynamic var names) can still slip through. It blocks accidental and
 * straightforward reads, not a determined adversary.
 */

// ── env-file name detection ────────────────────────────────────────────────

/** Trailing segments that mark a file as a non-secret sample/template. */
const ENV_SAMPLE_TAILS = new Set([
	"example",
	"sample",
	"template",
	"examples",
	"dist",
	"schema",
	"defaults",
]);

/**
 * True when `name` (a basename) is a secret-bearing env file.
 * Matches `.env`, `.env.<segs>`, `<prefix>.env`, `<prefix>.env.<segs>`,
 * but allows `.env.example` / `foo.env.sample` / `.env.production.template`.
 */
function isEnvFileName(name: string): boolean {
	if (!/\.env(?:\.[\w-]+)*$/i.test(name)) return false;
	const parts = name.toLowerCase().split(".");
	const envIdx = parts.indexOf("env");
	if (envIdx === -1) return false;
	const tail = parts.slice(envIdx + 1); // segments after the "env" segment
	if (tail.length === 0) return true; // exactly `.env` / `foo.env` → secret
	return !ENV_SAMPLE_TAILS.has(tail[tail.length - 1]);
}

/** True when the basename of `path` is a secret env file (case-insensitive). */
function isEnvFile(path: string): boolean {
	return isEnvFileName(basename(path));
}

// ── text token scan for .env file references (bash + code) ───────────────────────────────────────────────

/**
 * Path-like tokens that contain a `.env` segment, bounded by shell/code
 * delimiters. `~`, `/` and `=` are leading boundaries so `$HOME/.env`,
 * `~/.env` and `f=.env` are caught; a bare `.env` is caught too because the
 * prefix is optional (`*?`). `*` is a trailing boundary so `*.env*` is caught.
 */
const ENV_PATH_TOKEN =
	/(?:^|[\s"'`<>&|;()~\/=])((?:[~.$\w*\/-])*?\.env(?:\.[\w-]+)*)(?=$|[\s"'`<>&|;()\/\*])/gi;

/** Env-var accessor names containing a `.env` substring but NOT file paths. */
const NON_FILE_ENV_ACCESSORS = [
	/\bprocess\.env\b/gi,
	/\bimport\.meta\.env\b/gi,
	/\bBun\.env\b/gi,
	/\bDeno\.env\b/gi,
];

/** True if `text` references a secret env file as a path/string literal. */
function textAccessesEnvFile(text: string): boolean {
	let cleaned = text;
	for (const re of NON_FILE_ENV_ACCESSORS) {
		cleaned = cleaned.replace(re, "");
	}
	for (const m of cleaned.matchAll(ENV_PATH_TOKEN)) {
		const base = (m[1] as string).split("/").pop() ?? (m[1] as string);
		if (isEnvFileName(base)) return true;
	}
	return false;
}

// ── glob reads that could expand to a .env file ──────────────────────

/**
 * Glob tokens: a path-like token containing a glob metachar (`*`, `?`, `[`).
 * A glob is "risky" (could resolve to a secret env file) when it is a dotfile
 * glob (`.*`, `.en*`, `.e?v`) or contains the substring `env` (`*.env`,
 * `*env*`). Reading non-dot, non-env globs like `*.js` is allowed.
 */
const GLOB_TOKEN =
	/(?:^|[\s"'`<>&|;()~\/=])([~.$\w*\/?\[\]-]*[*?\[][~.$\w*\/?\[\]-]*)/gi;

function textHasRiskyGlob(text: string): boolean {
	for (const m of text.matchAll(GLOB_TOKEN)) {
		const tok = m[1] as string;
		const base = tok.split("/").pop() || tok;
		const hasGlob = /[*?\[]/.test(base);
		if (base.startsWith(".") && hasGlob) return true; // .* / .en* / .e?v
		if (/env/i.test(tok) && /[*?\[]/.test(tok)) return true; // *.env / *env*
	}
	return false;
}

// ── environment-variable detection in bash commands ──────────────────

/**
 * Commands whose primary purpose is dumping the environment. Leading
 * boundaries include `-c ` (with optional quote) so `sh -c env` /
 * `bash -c 'env'` are caught; trailing terminators include `>` `'` `"` so a
 * redirect (`env > file`) or a quoted wrapper arg are caught.
 */
const ENV_DUMP_PATTERNS = [
	/\bprintenv\b/i,
	/(?:^|[;&|`(]|-c\s+['"]?)\s*env(?:\s+-\w+)*\s*(?=$|[;&|)`>'"])/i,
	/(?:^|[;&|`(]|-c\s+['"]?)\s*export(?:\s+-\w+)*\s*(?=$|[;&|)`>'"])/i,
	/\b(?:declare|typeset)\s+-p\b/i,
	/(?:^|[;&|`(]|-c\s+['"]?)\s*(?:declare|typeset)(?:\s+-\w+)*\s*(?=$|[;&|)`>'"])/i,
	/(?:^|[;&|`(]|-c\s+['"]?)\s*set\s*(?=$|[;&|)`>'"])/i,
];

/** Variable names that look secret-y (gate `echo $VAR`-style reads). */
const SECRET_VAR_RE =
	/(?:API|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|PASS|PRIVATE|KEY|CREDENTIAL|AUTH|ACCESS|CLIENT|SIGN|CERT|CONN(?:ECTION)?|DATABASE|DB|JENKINS|AWS|GITHUB|GITLAB|OPENAI|ANTHROPIC|STRIPE|SENTRY|VAULT|KUBECONFIG|KUBE|PG_|POSTGRES|MYSQL|REDIS|MONGO|NPM_|SUPABASE|FIREBASE|DATADOG)/i;

/** `echo $VAR` / `cat <<< $VAR` / `printf … $VAR` style reads. */
const PRINT_VAR_RE =
	/\b(?:echo|printf|cat|print|less|more|head|tail|tee)\b[^|;&\n]*\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/gi;

/** Quoted dump-command string literals, e.g. execSync("env"), os.system('printenv'). */
const QUOTED_DUMP_RE =
	/(['"`])\s*(?:printenv|env|export|declare|typeset|set)(?:\s+-?\w+)*\s*\1/i;

/** True if a shell command reads OS environment variables. */
function commandAccessesEnvVar(command: string): boolean {
	for (const re of ENV_DUMP_PATTERNS) {
		if (re.test(command)) return true;
	}
	// /proc/<anything>/environ — incl. self, a pid, `$$`, `$BASHPID`, `$VAR`.
	if (/\/proc\/[^/\s'"]+\/environ\b/i.test(command)) return true;
	if (/\bps\s+e(?:ww)?\b/i.test(command)) return true;
	if (/\bawk\b[^|;&]*\bENVIRON\b/i.test(command)) return true;
	let m: RegExpExecArray | null;
	PRINT_VAR_RE.lastIndex = 0;
	while ((m = PRINT_VAR_RE.exec(command)) !== null) {
		if (SECRET_VAR_RE.test(m[1] as string)) return true;
	}
	return false;
}

// ── environment-variable detection in code (ctx_execute) ──────────────

/** Generic env-access APIs (always checked, any language). */
const CODE_ENV_GENERIC = [
	/\bprocess\.env\b/i,
	/\bimport\.meta\.env\b/i,
	/\bBun\.env\b/i,
	/\bDeno\.env\b/i,
	/\bos\.environ(?:v?iron)?\b/i,
	/\bos\.getenv\b/i,
	/\bgetenv\s*\(/i,
	/\bENV\s*[\[.]/i,
	/\bSystem\.get_env\b/i,
	/\bstd::env::(?:var|vars)\b/i,
	/\benv::(?:var|vars)\b/i,
	/\bEnvironment\.GetEnvironmentVariable/i,
	/\bEnviron\s*\(/i,
	/\$_ENV\b/i,
	/\$_SERVER\b/i,
	/\$env:/i,
	/\$ENV\{/,
	/\b%ENV\b/,
	/\bSys\.getenv\b/i,
	/\/proc\/[^/\s'"]+\/environ/i, // reading the environ file from code
];

/** Language-specific env-access APIs (checked in addition to generic). */
const CODE_ENV_BY_LANG: Record<string, RegExp[]> = {
	javascript: [],
	typescript: [],
	python: [],
	ruby: [/\bENV\.to_(?:h|a)\b/i],
	go: [/\bos\.Getenv\b/, /\bos\.Environ\b/, /\bos\.LookupEnv\b/],
	rust: [],
	php: [],
	perl: [],
	csharp: [],
	elixir: [/\bSystem\.fetch_env(?:!)?\b/i],
	r: [],
	shell: [], // handled via commandAccessesEnvVar
};

/** True if `code` reads OS env vars. Shell code is treated like a command. */
function codeAccessesEnvVar(code: string, language?: string): boolean {
	if (language === "shell") {
		return commandAccessesEnvVar(code);
	}
	for (const re of CODE_ENV_GENERIC) {
		if (re.test(code)) return true;
	}
	const extra = (language && CODE_ENV_BY_LANG[language]) || [];
	for (const re of extra) {
		if (re.test(code)) return true;
	}
	// Spawning a subprocess that dumps the env, e.g. execSync("env").
	if (QUOTED_DUMP_RE.test(code)) return true;
	return false;
}

// ── extension ──────────────────────────────────────────────────────────

const FILE_REASON =
	"Reading .env files is blocked. If you really need an env value, ask the user to read it for you.";
const VAR_REASON =
	"Reading environment variables is blocked. If you really need an env value, ask the user to read it for you.";
const GLOB_REASON = "risk to expose env variable, try differently";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		switch (event.toolName) {
			// ── tools with a `path` parameter ──────────────────────
			case "read":
			case "edit":
			case "write":
			case "ls": {
				const path = event.input.path as string | undefined;
				if (path && isEnvFile(path)) {
					return { block: true, reason: FILE_REASON };
				}
				break;
			}

			// ── grep: check path and glob ──────────────────────────
			case "grep": {
				const input = event.input as {
					path?: string;
					glob?: string;
				};
				if (input.path && isEnvFile(input.path)) {
					return { block: true, reason: FILE_REASON };
				}
				if (input.glob && /\.env/i.test(input.glob)) {
					return { block: true, reason: FILE_REASON };
				}
				break;
			}

			// ── find: check path and pattern ───────────────────────
			case "find": {
				const input = event.input as {
					path?: string;
					pattern: string;
				};
				if (input.path && isEnvFile(input.path)) {
					return { block: true, reason: FILE_REASON };
				}
				if (/\.env/i.test(input.pattern)) {
					return { block: true, reason: FILE_REASON };
				}
				break;
			}

			// ── bash: file-ref + glob + env-var scan ────────────────
			case "bash": {
				const command = event.input.command as string;
				if (textAccessesEnvFile(command)) {
					return { block: true, reason: FILE_REASON };
				}
				if (textHasRiskyGlob(command)) {
					return { block: true, reason: GLOB_REASON };
				}
				if (commandAccessesEnvVar(command)) {
					return { block: true, reason: VAR_REASON };
				}
				break;
			}

			// ── ctx_execute_file: path + code scan ───────────────
			case "ctx_execute_file": {
				const input = event.input as {
					path?: string;
					code?: string;
					language?: string;
				};
				if (input.path && isEnvFile(input.path)) {
					return { block: true, reason: FILE_REASON };
				}
				if (input.code) {
					if (textAccessesEnvFile(input.code)) {
						return { block: true, reason: FILE_REASON };
					}
					if (textHasRiskyGlob(input.code)) {
						return { block: true, reason: GLOB_REASON };
					}
					if (codeAccessesEnvVar(input.code, input.language)) {
						return { block: true, reason: VAR_REASON };
					}
				}
				break;
			}

			// ── ctx_execute: code scan (file refs + glob + env APIs) ──────
			case "ctx_execute": {
				const input = event.input as { code?: string; language?: string };
				if (input.code) {
					if (textAccessesEnvFile(input.code)) {
						return { block: true, reason: FILE_REASON };
					}
					if (textHasRiskyGlob(input.code)) {
						return { block: true, reason: GLOB_REASON };
					}
					if (codeAccessesEnvVar(input.code, input.language)) {
						return { block: true, reason: VAR_REASON };
					}
				}
				break;
			}

			// ── ctx_batch_execute: scan each command (file + glob + env) ────────────
			case "ctx_batch_execute": {
				const commands = event.input.commands as
					| { command: string }[]
					| undefined;
				if (commands) {
					for (const cmd of commands) {
						if (textAccessesEnvFile(cmd.command)) {
							return { block: true, reason: FILE_REASON };
						}
						if (textHasRiskyGlob(cmd.command)) {
							return { block: true, reason: GLOB_REASON };
						}
						if (commandAccessesEnvVar(cmd.command)) {
							return { block: true, reason: VAR_REASON };
						}
					}
				}
				break;
			}

			// ── ctx_index: block path + inject excludes (skips env files ──
			//    from the searchable knowledge base)
			case "ctx_index": {
				const input = event.input as { path?: string; exclude?: string[] };
				if (input.path && isEnvFile(input.path)) {
					return { block: true, reason: FILE_REASON };
				}
				const excludes = input.exclude ?? [];
				for (const g of ["**/.env", "**/.env.*", "**/*.env", "**/*.env.*"]) {
					if (!excludes.includes(g)) excludes.push(g);
				}
				input.exclude = excludes; // mutate input → affects execution
				break;
			}
		}

		return undefined;
	});
}
