import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import registerConfirmWrites from "../extensions/confirm-writes.ts";
import registerBlockEnvReads from "../extensions/block-env-reads.ts";
import registerConfirmReadsOutsideCwd from "../extensions/confirm-reads-outside-cwd.ts";

type ToolCallHandler = (
	event: { type: "tool_call"; toolCallId: string; toolName: string; input: Record<string, unknown> },
	ctx: {
		cwd: string;
		hasUI: boolean;
		ui: {
			confirm: (title: string, message: string) => Promise<boolean>;
			input: () => Promise<string>;
		};
	},
) => Promise<{ block?: boolean; reason?: string } | undefined>;

test("every bash command requires consent and is blocked without UI or when consent is denied", async () => {
	let handler: ToolCallHandler | undefined;
	const fakeAPI = {
		registerTool() {},
		on(event: string, callback: ToolCallHandler) {
			if (event === "tool_call") handler = callback;
		},
	};
	registerConfirmWrites(fakeAPI as unknown as Parameters<typeof registerConfirmWrites>[0]);
	assert.ok(handler, "extension must register a tool_call handler");

	// Inert inputs only: the handler is called directly; no shell is spawned.
	const commands = [
		"rg needle ./synthetic-input",
		"grep needle ./synthetic-input",
		"find ./synthetic-input -maxdepth 1 -name '*.ts'",
		"ls ./synthetic-input",
		"codegraph explore ./synthetic-input",
		'rg "$(printf synthetic-marker)" ./synthetic-input',
		'grep "`printf synthetic-marker`" ./synthetic-input',
		"rg '$(printf synthetic-marker)' ./synthetic-input",
		'rg \'synthetic-\'"$(printf marker)" ./synthetic-input',
		"ls ./synthetic-input && printf synthetic-marker",
		"ls ./synthetic-input || printf synthetic-marker",
		"ls ./synthetic-input; printf synthetic-marker",
		"ls ./synthetic-input\nprintf synthetic-marker",
		"ls ./synthetic-input | grep needle",
		"find ./synthetic-input -exec printf synthetic-marker \\;",
		"find ./synthetic-input -delete",
		"find ./synthetic-input -fprint ./synthetic-output",
		"rg --pre=./synthetic-helper needle ./synthetic-input",
		"rg --replace=synthetic-replacement needle ./synthetic-input",
		"ls ./synthetic-input > ./synthetic-output",
		"rg-synthetic needle ./synthetic-input",
		"ls.synthetic ./synthetic-input",
		"codegraph explore-synthetic ./synthetic-input",
		"SYNTHETIC_FLAG=1 ls ./synthetic-input",
		"printf synthetic-marker",
	];
	const violations: string[] = [];
	for (const hasUI of [false, true]) {
		for (const command of commands) {
			let confirmationRequested = false;
			const result = await handler(
				{ type: "tool_call", toolCallId: "synthetic-call", toolName: "bash", input: { command } },
				{
					cwd: "/synthetic-shell-consent-project",
					hasUI,
					ui: {
						async confirm() {
							confirmationRequested = true;
							return false;
						},
						async input() { return "synthetic denial"; },
					},
				},
			);
			const label = `${hasUI ? "UI" : "headless"}: ${JSON.stringify(command)}`;
			if (result?.block !== true) violations.push(`${label}: expected block:true`);
			if (hasUI && !confirmationRequested) violations.push(`${label}: expected confirmation request`);
		}
	}
	assert.deepEqual(violations, [], "bash must never bypass the consent boundary");
});

test("structured search runs headlessly without processes and stays inside non-secret project files", async (t) => {
	type SearchTool = {
		name: string;
		execute: (
			id: string, input: Record<string, unknown>, signal: AbortSignal,
			onUpdate: undefined, ctx: Parameters<ToolCallHandler>[1],
		) => Promise<{ content: Array<{ type: string; text?: string }> }>;
	};
	const tools = new Map<string, SearchTool>();
	let handler: ToolCallHandler | undefined;
	registerConfirmWrites({
		on(event: string, callback: ToolCallHandler) {
			if (event === "tool_call") handler = callback;
		},
		registerTool(tool: SearchTool) { tools.set(tool.name, tool); },
	} as unknown as Parameters<typeof registerConfirmWrites>[0]);
	for (const name of ["grep", "find", "ls"]) {
		assert.ok(tools.has(name), `extension must register secured ${name} override`);
	}
	assert.ok(handler, "extension must register a tool_call handler");

	const root = await mkdtemp(path.join(fileURLToPath(new URL(".", import.meta.url)), "search-boundary-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const project = path.join(root, "project");
	const sibling = path.join(root, "sibling");
	for (const dir of ["src/nested", "ignored", ".git"]) {
		await mkdir(path.join(project, dir), { recursive: true });
	}
	await mkdir(sibling);
	const literal = '$(printf synthetic-marker); `printf synthetic-marker`';
	const files: Record<string, string> = {
		"src/alpha.ts": `ordinary-needle\n${literal}\n`,
		"src/nested/beta.ts": "ordinary-needle\n",
		"src/auth.ts": "ordinary-needle\n",
		"README.md": "ordinary documentation\n",
		".gitignore": "ignored/\n",
		"ignored/hidden.ts": "ordinary-needle DUMMY_IGNORED\n",
		".env": "ordinary-needle DUMMY_ENV_ONLY\n",
		".env.example": "EXAMPLE_ALLOWED=yes\n",
		"credentials.json": "ordinary-needle DUMMY_CREDENTIALS_ONLY\n",
		".git/private.ts": "ordinary-needle DUMMY_GIT_ONLY\n",
	};
	for (const [name, content] of Object.entries(files)) await writeFile(path.join(project, name), content);
	await writeFile(path.join(sibling, "outside.ts"), "ordinary-needle DUMMY_OUTSIDE_ONLY\n");
	await symlink(path.join(sibling, "outside.ts"), path.join(project, "linked-file.ts"));
	await symlink(sibling, path.join(project, "linked-dir"));

	// Guard the process boundary, including ESM named imports; never execute input as shell text.
	const launches: string[] = [];
	for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const) {
		t.mock.method(childProcess, method, () => {
			launches.push(method);
			throw new Error("Process launch forbidden during structured search");
		});
	}
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		assert.deepEqual(launches, [], "structured search must not launch processes, even if errors are caught");
	});
	const ctx = {
		cwd: project,
		hasUI: false,
		ui: {
			async confirm(): Promise<boolean> { assert.fail("read-only tools must not request confirmation"); },
			async input(): Promise<string> { assert.fail("read-only tools must not request input"); },
		},
	};
	for (const [toolName, input] of [
		["grep", { pattern: "ordinary-needle", path: "." }],
		["find", { pattern: "**/*.ts", path: "." }],
		["ls", { path: "." }],
		["contact_supervisor", { reason: "progress_update", message: "synthetic update" }],
	] as Array<[string, Record<string, unknown>]>) {
		const result = await handler({ type: "tool_call", toolCallId: "search-call", toolName, input }, ctx);
		assert.notEqual(result?.block, true, `${toolName} must be allowed headlessly`);
	}
	async function execute(name: string, input: Record<string, unknown>) {
		const result = await tools.get(name)!.execute("search-call", input, new AbortController().signal, undefined, ctx);
		return result.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
	}
	const excluded = /DUMMY_|hidden\.ts|private\.ts|outside\.ts|linked-file|linked-dir|credentials\.json|\.env(?!\.example)\b|\.git(?:\/|\s|$)/;
	const matches = await execute("grep", { pattern: "ordinary-needle", path: "." });
	assert.match(matches, /src\/alpha\.ts/);
	assert.match(matches, /src\/nested\/beta\.ts/);
	assert.match(matches, /src\/auth\.ts/);
	assert.match(matches, /ordinary-needle/);
	assert.doesNotMatch(matches, excluded);
	const literalMatches = await execute("grep", { pattern: literal, literal: true, path: "." });
	assert.match(literalMatches, /alpha\.ts/);
	assert.ok(literalMatches.includes(literal), "shell-looking pattern must match as literal data");
	assert.doesNotMatch(literalMatches, /beta\.ts/);
	const found = await execute("find", { pattern: "**/*.ts", path: "." });
	assert.match(found, /src\/alpha\.ts/);
	assert.match(found, /src\/nested\/beta\.ts/);
	assert.match(found, /src\/auth\.ts/);
	assert.doesNotMatch(found, excluded);
	assert.doesNotMatch(found, /README\.md|\.env\.example|\.gitignore/);
	const listing = await execute("ls", { path: "." });
	assert.match(listing, /\bsrc\/?\b/);
	assert.match(listing, /README\.md/);
	assert.match(listing, /\.env\.example/);
	assert.doesNotMatch(listing, excluded);
	assert.doesNotMatch(listing, /\bignored\b/);
	assert.match(await execute("grep", { pattern: "EXAMPLE_ALLOWED", path: ".env.example" }), /EXAMPLE_ALLOWED/);

	for (const name of ["grep", "find", "ls"]) {
		for (const target of [sibling, "../sibling", "linked-dir", "linked-file.ts", ".env", "credentials.json", ".git"]) {
			await assert.rejects(
				() => execute(name, { path: target, ...(name === "grep" ? { pattern: "ordinary-needle" } : name === "find" ? { pattern: "**/*.ts" } : {}) }),
				(error: Error) => {
					assert.match(error.message, /denied|blocked|outside|not allowed|secret|sensitive|symlink|symbolic|restricted|forbidden|not a directory|directory required/i);
					assert.doesNotMatch(error.message, /no (?:matches|files|results|entries)|empty directory/i);
					assert.doesNotMatch(error.message, /DUMMY_/);
					return true;
				},
				`${name} must fail explicitly for ${target}, not report empty results`,
			);
		}
	}
});

test("secured search rejects direct and symlink-aliased git working directories before traversal", async (t) => {
	type SearchTool = {
		name: string;
		execute: (
			id: string, input: Record<string, unknown>, signal: AbortSignal,
			onUpdate: undefined, ctx: Parameters<ToolCallHandler>[1],
		) => Promise<unknown>;
	};
	const tools = new Map<string, SearchTool>();
	registerConfirmWrites({
		on() {},
		registerTool(tool: SearchTool) { tools.set(tool.name, tool); },
	} as unknown as Parameters<typeof registerConfirmWrites>[0]);
	const root = await mkdtemp(path.join(fileURLToPath(new URL(".", import.meta.url)), "git-cwd-boundary-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const gitDir = path.join(root, "project/.git");
	await mkdir(path.join(gitDir, "nested"), { recursive: true });
	await writeFile(path.join(gitDir, "config"), "DUMMY_GIT_CONFIG_ONLY\n");
	await writeFile(path.join(gitDir, "nested/value.ts"), "DUMMY_GIT_SOURCE_ONLY\n");
	const alias = path.join(root, "innocent-alias");
	await symlink(gitDir, alias);
	const traversals: string[] = [];
	t.mock.method(fsPromises, "readdir", (...args: unknown[]) => {
		traversals.push(String(args[0]));
		throw new Error("Unexpected directory traversal");
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		assert.deepEqual(traversals, [], "protected cwd must be rejected before any directory enumeration");
	});
	for (const cwd of [gitDir, path.join(gitDir, "nested"), alias, path.join(alias, "nested")]) {
		for (const hasUI of [false, true]) {
			const ctx = {
				cwd, hasUI,
				ui: {
					async confirm(): Promise<boolean> { assert.fail("git cwd must never offer confirmation"); },
					async input(): Promise<string> { assert.fail("git cwd must never request input"); },
				},
			};
			for (const name of ["grep", "find", "ls"]) {
				assert.ok(tools.has(name), `extension must register secured ${name}`);
				const input = { path: ".", ...(name === "grep" ? { pattern: "DUMMY_" } : name === "find" ? { pattern: "**/*" } : {}) };
				await assert.rejects(
					() => tools.get(name)!.execute("git-cwd-call", input, new AbortController().signal, undefined, ctx),
					(error: Error) => {
						assert.match(error.message, /denied|blocked|not allowed|restricted|forbidden|protected|symlink|symbolic/i);
						assert.doesNotMatch(error.message, /DUMMY_|no (?:matches|files|results|entries)|empty directory/i);
						return true;
					},
					`${name} must reject protected cwd ${cwd} explicitly, even with UI=${hasUI}`,
				);
			}
		}
	}
});

test("native search excludes subagent control state and rejects protected targets before traversal", async (t) => {
	type SearchTool = {
		name: string;
		execute: (id: string, input: Record<string, unknown>, signal: AbortSignal,
			onUpdate: undefined, ctx: Parameters<ToolCallHandler>[1]) =>
			Promise<{ content: Array<{ type: string; text?: string }> }>;
	};
	const tools = new Map<string, SearchTool>();
	registerConfirmWrites({
		on() {},
		registerTool(tool: SearchTool) { tools.set(tool.name, tool); },
	} as unknown as Parameters<typeof registerConfirmWrites>[0]);
	const root = await mkdtemp(path.join(fileURLToPath(new URL(".", import.meta.url)), "control-search-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const project = path.join(root, "project");
	const state = path.join(project, ".pi-subagents");
	await mkdir(path.join(state, "nested"), { recursive: true });
	await writeFile(path.join(state, "state.json"), '{"marker":"control-needle DUMMY_CONTROL_ONLY"}\n');
	await writeFile(path.join(project, "ordinary.ts"), "control-needle ORDINARY_SOURCE_ONLY\n");
	const ctx = {
		cwd: project, hasUI: false,
		ui: {
			async confirm(): Promise<boolean> { assert.fail("native search must not request consent"); },
			async input(): Promise<string> { assert.fail("native search must not request input"); },
		},
	};
	function execute(name: string, target: string, cwd = project) {
		assert.ok(tools.has(name), `extension must register secured ${name}`);
		return tools.get(name)!.execute("control-search-call", {
			path: target, ...(name === "grep" ? { pattern: "control-needle" } : name === "find" ? { pattern: "**/*" } : {}),
		}, new AbortController().signal, undefined, { ...ctx, cwd });
	}
	for (const name of ["grep", "find", "ls"]) {
		await t.test(`${name} broad results exclude control state`, async () => {
			const result = await execute(name, ".");
			const text = result.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
			assert.match(text, /ordinary\.ts/, "ordinary source must remain discoverable");
			if (name === "grep") assert.match(text, /ORDINARY_SOURCE_ONLY/);
			assert.doesNotMatch(text, /\.pi-subagents|state\.json|DUMMY_CONTROL_ONLY/);
		});
		for (const [cwd, target] of [[project, ".pi-subagents"], [state, "."], [path.join(state, "nested"), "."]]) {
			await t.test(`${name} rejects ${target} from ${cwd} before traversal`, async (subtest) => {
				const traversals: string[] = [];
				subtest.mock.method(fsPromises, "readdir", (...args: unknown[]) => {
					traversals.push(String(args[0]));
					throw new Error("Unexpected directory traversal");
				});
				syncBuiltinESMExports();
				try {
					await assert.rejects(() => execute(name, target, cwd), (error: Error) => {
						assert.match(error.message, /denied|blocked|not allowed|restricted|forbidden|protected/i);
						assert.doesNotMatch(error.message, /DUMMY_|no (?:matches|files|results|entries)|empty directory/i);
						return true;
					});
					assert.deepEqual(traversals, [], "protected state must be rejected before enumeration");
				} finally {
					subtest.mock.restoreAll();
					syncBuiltinESMExports();
				}
			});
		}
	}
});

test("read consent rejects path mutation and symlink replacement after approval", async (t) => {
	let handler: ToolCallHandler | undefined;
	registerConfirmReadsOutsideCwd({
		on(event: string, callback: ToolCallHandler) {
			if (event === "tool_call") handler = callback;
		},
	} as unknown as Parameters<typeof registerConfirmReadsOutsideCwd>[0]);
	assert.ok(handler);
	const root = await mkdtemp(path.join(fileURLToPath(new URL(".", import.meta.url)), "read-consent-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const project = path.join(root, "project");
	const sibling = path.join(root, "sibling");
	await mkdir(project);
	await mkdir(sibling);
	const outside = path.join(sibling, "outside.ts");
	const other = path.join(sibling, "other.ts");
	await writeFile(outside, "DUMMY_READ_ORIGINAL_ONLY\n");
	await writeFile(other, "DUMMY_READ_OTHER_ONLY\n");
	// Permission events only; no read tool is ever executed.
	for (const change of ["unchanged", "path", "symlink"] as const) {
		const input: Record<string, unknown> = { path: outside };
		let confirmations = 0;
		const result = await handler({ type: "tool_call", toolCallId: "read-consent-call", toolName: "read", input }, {
			cwd: project, hasUI: true,
			ui: {
				async confirm(title, message) {
					confirmations++;
					assert.ok(title.includes(outside));
					assert.ok(message.includes(JSON.stringify(outside)));
					if (change === "path") input.path = other;
					if (change === "symlink") {
						await rm(outside);
						await symlink(other, outside);
					}
					return true;
				},
				async input(): Promise<string> { assert.fail("read consent must not request extra input"); },
			},
		});
		assert.equal(confirmations, 1, `${change}: read must request explicit consent`);
		assert.equal(result?.block === true, change !== "unchanged", `${change}: only the unchanged approved target may proceed`);
	}
});

test("file authority requires explicit UI consent for outside and config paths but never overrides permanent denials", async (t) => {
	const handlers: ToolCallHandler[] = [];
	const fakeAPI = {
		registerTool() {},
		on(event: string, callback: ToolCallHandler) {
			if (event === "tool_call") handlers.push(callback);
		},
	};
	// Match pi-subagent-safe's registration and short-circuit dispatch order.
	for (const register of [registerBlockEnvReads, registerConfirmReadsOutsideCwd, registerConfirmWrites]) {
		register(fakeAPI as unknown as Parameters<typeof register>[0]);
	}
	assert.equal(handlers.length, 3);
	const testsDir = fileURLToPath(new URL(".", import.meta.url));
	const repo = path.resolve(testsDir, "../..");
	const root = await mkdtemp(path.join(testsDir, "file-authority-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const project = path.join(root, "project");
	const sibling = path.join(root, "sibling");
	for (const dir of ["src/auth", "src/dist"]) await mkdir(path.join(project, dir), { recursive: true });
	for (const name of ["src/auth.ts", "src/auth/handler.ts", "src/dist/value.ts"]) {
		await writeFile(path.join(project, name), "export const ordinarySource = true;\n");
	}
	await mkdir(sibling);
	const ordinary = "export const synthetic = 1;\n";
	await writeFile(path.join(project, "src/ordinary.ts"), ordinary);
	await writeFile(path.join(sibling, "outside.ts"), ordinary);
	const protectedDirs = [".git", "nested/.Pi", "nested/.AgEnTs", "nested/.GiT"];
	for (const dir of protectedDirs) {
		await mkdir(path.join(project, dir), { recursive: true });
		await writeFile(path.join(project, dir, "existing.ts"), ordinary);
	}
	// Synthetic secrets only; guard decisions never execute a read/edit/write tool.
	for (const name of [".env", "credentials.json"]) {
		await writeFile(path.join(project, name), "DUMMY_NOT_A_SECRET\n");
	}
	await symlink(path.join(project, "src/ordinary.ts"), path.join(project, "internal-link.ts"));
	await symlink(path.join(project, "src"), path.join(project, "internal-dir"));
	await symlink(path.join(sibling, "outside.ts"), path.join(project, "external-link.ts"));
	await symlink(sibling, path.join(project, "external-dir"));
	await link(path.join(project, "src/ordinary.ts"), path.join(project, "hardlinked.ts"));
	// Keep the ordinary positive control single-linked.
	await writeFile(path.join(project, "src/plain.ts"), ordinary);
	const violations: string[] = [];
	async function check(toolName: string, input: Record<string, unknown>, policy: "allow" | "deny" | "confirm", hasUI: boolean, consent: boolean, cwd = project) {
		const blocked = policy === "deny" || (policy === "confirm" && (!hasUI || !consent));
		const label = `${hasUI ? "UI" : "headless"} consent=${consent} ${toolName} ${JSON.stringify(input)} cwd=${cwd}`;
		let confirmations = 0;
		try {
			let result: Awaited<ReturnType<ToolCallHandler>>;
			for (const handler of handlers) {
				result = await handler({ type: "tool_call", toolCallId: "file-authority-call", toolName, input }, {
					cwd, hasUI,
					ui: {
						async confirm(): Promise<boolean> {
							confirmations++;
							return consent;
						},
						async input(): Promise<string> { throw new Error("File authority must not request input"); },
					},
				});
				if (result?.block === true) break;
			}
			if ((result?.block === true) !== blocked) violations.push(`${label}: expected ${blocked ? "block:true" : "allow"}`);
		} catch (error) {
			violations.push(`${label}: expected a permission decision, got ${String(error)}`);
		}
		const expectedConfirmations = policy === "confirm" && hasUI ? 1 : 0;
		if (confirmations !== expectedConfirmations) violations.push(`${label}: expected ${expectedConfirmations} dialogs, got ${confirmations}`);
	}
	function inputFor(toolName: string, target: unknown): Record<string, unknown> {
		return {
			...(target === undefined ? {} : { path: target }),
			...(toolName === "edit" ? { oldText: ordinary, newText: "export const synthetic = 2;\n" } : {}),
			...(toolName === "write" ? { content: ordinary } : {}),
		};
	}
	const forbidden: unknown[] = [
		"internal-link.ts", "external-link.ts",
		"internal-dir/ordinary.ts", "internal-dir/new/deep.ts",
		"external-dir/outside.ts", "external-dir/new/deep.ts",
		"hardlinked.ts", "src/ordinary.ts",
		...[".git", "nested/.GiT"].flatMap((dir) => [`${dir}/existing.ts`, `${dir}/new/deep.ts`]),
		"src", // Existing directories are not regular file targets.
		".env", "new/.env.production", "credentials.json", "new/credentials.json",
		undefined, null, "", 42, {}, [], "src/invalid\0.ts",
	];
	for (const { hasUI, consent } of [{ hasUI: false, consent: true }, { hasUI: true, consent: false }, { hasUI: true, consent: true }]) {
		for (const toolName of ["read", "edit", "write"]) {
			for (const target of ["src/plain.ts", "src/auth.ts", "src/auth/handler.ts", "src/dist/value.ts"]) {
				await check(toolName, inputFor(toolName, target), "allow", hasUI, consent);
			}
			for (const target of [path.join(sibling, "outside.ts"), "../sibling/outside.ts"]) {
				await check(toolName, inputFor(toolName, target), "confirm", hasUI, consent);
			}
			await check(toolName, inputFor(toolName, "../sibling/new/deep.ts"), toolName === "write" ? "confirm" : "deny", hasUI, consent);
			for (const dir of ["nested/.Pi", "nested/.AgEnTs"]) {
				await check(toolName, inputFor(toolName, `${dir}/existing.ts`), toolName === "read" ? "deny" : "confirm", hasUI, consent);
				await check(toolName, inputFor(toolName, `${dir}/new/deep.ts`), toolName === "write" ? "confirm" : "deny", hasUI, consent);
			}
			await check(toolName, inputFor(toolName, path.join(project, "src/plain.ts")), "allow", hasUI, consent);
			for (const target of forbidden) await check(toolName, inputFor(toolName, target), "deny", hasUI, consent);
		}
		await check("write", inputFor("write", "src/new/nested/source.ts"), "allow", hasUI, consent);
		await check("read", { path: path.join(repo, "agent/skills/tdd/SKILL.md") }, "allow", hasUI, consent);
		// Invalid edits must not get permission merely because execution would fail.
		// Only disposable, non-secret fixtures may reach legacy edit prevalidation.
		for (const target of [".git/existing.ts", "internal-link.ts"]) {
			await check("edit", { path: target, edits: [{ oldText: "absent synthetic text", newText: "inert replacement" }] }, "deny", hasUI, consent);
		}
		// No edits array here: legacy prevalidation must not read installation files.
		for (const target of [
			"agent/extensions/confirm-writes.ts", "agent/extensions/lib/secure-search.ts",
			"agent/bin/pi-subagent-safe", "agent/settings.json", "agent/agents/implementer.md",
		]) {
			for (const toolName of ["edit", "write"]) await check(toolName, inputFor(toolName, target), "confirm", hasUI, consent, repo);
		}
	}
	for (const toolName of ["goulven_synthetic_write", "goulven_search", "codegraph_synthetic_write", "codegraph_explore"]) {
		await check(toolName, { path: "../sibling/new.ts" }, "deny", false, true);
	}
	assert.deepEqual(violations, [], "combined guards must enforce permanent denials and explicit, single-dialog UI consent");
});

test("write consent binds the complete payload and target, revalidates links, and protects runtime control state", async (t) => {
	const handlers: ToolCallHandler[] = [];
	const fakeAPI = {
		registerTool() {},
		on(event: string, callback: ToolCallHandler) {
			if (event === "tool_call") handlers.push(callback);
		},
	};
	for (const register of [registerBlockEnvReads, registerConfirmReadsOutsideCwd, registerConfirmWrites]) {
		register(fakeAPI as unknown as Parameters<typeof register>[0]);
	}
	assert.equal(handlers.length, 3);
	const testsDir = fileURLToPath(new URL(".", import.meta.url));
	const agentDir = path.resolve(testsDir, "..");
	const root = await mkdtemp(path.join(testsDir, "write-consent-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const project = path.join(root, "project");
	const sibling = path.join(root, "sibling");
	const subagents = path.join(project, ".pi-subagents");
	await mkdir(subagents, { recursive: true });
	await mkdir(sibling);
	const outside = path.join(sibling, "outside.ts");
	const other = path.join(sibling, "other.ts");
	await writeFile(outside, "DUMMY_ORIGINAL_ONLY\n");
	await writeFile(other, "DUMMY_OTHER_ONLY\n");
	const tail = "DISTINCTIVE_COMPLETE_WRITE_PAYLOAD_TAIL";
	const content = `${Array.from({ length: 40 }, (_, i) => `inert payload line ${i + 1}`).join("\n")}\n${tail}\n`;

	// Dispatch permission events only: never execute a file tool, even after approval.
	async function check(target: string, cwd: string, hasUI: boolean, consent: boolean,
		mutate?: (input: Record<string, unknown>) => void | Promise<void>) {
		const input: Record<string, unknown> = { path: target, content };
		const event: Parameters<ToolCallHandler>[0] = {
			type: "tool_call", toolCallId: "write-consent-call", toolName: "write", input,
		};
		let confirmations = 0;
		let result: Awaited<ReturnType<ToolCallHandler>>;
		for (const handler of handlers) {
			result = await handler(event, {
				cwd, hasUI,
				ui: {
					async confirm(title, message) {
						confirmations++;
						assert.ok(title.includes(target), "confirmation must identify the approved target");
						assert.ok(message.includes(JSON.stringify(target)), "dialog must show the actual target");
						assert.ok(message.includes(JSON.stringify(content)), "dialog must contain the complete mutation payload");
						assert.ok(message.includes(tail), "payload beyond line 30 must not be truncated");
						await mutate?.(input);
						return consent;
					},
					async input(): Promise<string> { assert.fail("write consent must not request extra input"); },
				},
			});
			if (result?.block === true) break;
		}
		assert.equal(confirmations, hasUI ? 1 : 0, `${target}: explicit UI confirmation required`);
		assert.equal(result?.block === true, !hasUI || !consent || mutate !== undefined,
			`${target}: only unchanged, revalidated writes with explicit consent may proceed`);
	}
	for (const { hasUI, consent } of [
		{ hasUI: false, consent: true }, { hasUI: true, consent: false }, { hasUI: true, consent: true },
	]) {
		await check(outside, project, hasUI, consent);
		// These are decision inputs only; no real control-state files are created or changed.
		for (const relative of ["trust.json", "sessions/new-guard-test.json", "missions/new-guard-test.json"]) {
			await check(path.join(agentDir, relative), agentDir, hasUI, consent);
		}
		for (const cwd of [project, subagents]) {
			await check(path.join(subagents, "new-guard-test.json"), cwd, hasUI, consent);
		}
	}
	await check(outside, project, true, true, (input) => { input.path = other; });
	await check(outside, project, true, true, (input) => { input.content = "UNAPPROVED_REPLACEMENT\n"; });
	await check(outside, project, true, true, async () => {
		// Swap only disposable fixtures while the consent dialog is open.
		await rm(outside);
		await symlink(other, outside);
	});
});
