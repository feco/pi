import assert from "node:assert/strict";
import test from "node:test";
import fsPromises, { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import registerConfirmWrites from "../extensions/confirm-writes.ts";
import registerConfirmReads from "../extensions/confirm-reads-outside-cwd.ts";

type Context = {
	cwd: string; hasUI: boolean;
	ui: { confirm: () => Promise<boolean>; input: () => Promise<string> };
};
type ReadHandler = (
	event: { type: "tool_call"; toolCallId: string; toolName: string; input: Record<string, unknown> },
	ctx: Context,
) => Promise<{ block?: boolean; reason?: string } | undefined>;
type SearchTool = {
	name: string;
	execute: (id: string, input: Record<string, unknown>, signal: AbortSignal,
		onUpdate: undefined, ctx: Context) => Promise<{ content: Array<{ type: string; text?: string }> }>;
};

test("native search rejects nested configuration cwd before traversal without denying the installation repository", async (t) => {
	const tools = new Map<string, SearchTool>();
	registerConfirmWrites({
		on() {},
		registerTool(tool: SearchTool) { tools.set(tool.name, tool); },
	} as unknown as Parameters<typeof registerConfirmWrites>[0]);
	let readHandler: ReadHandler | undefined;
	registerConfirmReads({
		on(event: string, handler: ReadHandler) { if (event === "tool_call") readHandler = handler; },
	} as unknown as Parameters<typeof registerConfirmReads>[0]);
	assert.ok(readHandler, "read authorization must be registered");
	const names = ["grep", "find", "ls"] as const;
	for (const name of names) assert.ok(tools.has(name), `secured ${name} must be registered`);

	const testsDir = await realpath(fileURLToPath(new URL(".", import.meta.url)));
	const installation = path.resolve(testsDir, "../..");
	const root = await mkdtemp(path.join(testsDir, "search-config-cwd-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const project = path.join(root, "project");
	await mkdir(path.join(project, ".pi/nested"), { recursive: true });
	await mkdir(path.join(project, ".agents/nested"), { recursive: true });
	await writeFile(path.join(project, ".pi/settings.json"), '{"marker":"DUMMY_CONFIG_ONLY"}\n');
	await writeFile(path.join(project, ".agents/nested/config.json"), '{"marker":"DUMMY_CONFIG_ONLY"}\n');
	await writeFile(path.join(project, "ordinary.ts"), "ORDINARY_SEARCH_CWD_MARKER\n");
	const dialogs: string[] = [];
	const ui = {
		async confirm() { dialogs.push("confirm"); return true; },
		async input() { dialogs.push("input"); return ""; },
	};
	function execute(name: string, cwd: string, target: string, hasUI: boolean, pattern = "DUMMY_CONFIG_ONLY") {
		return tools.get(name)!.execute("nested-config-cwd", {
			path: target, ...(name === "grep" ? { pattern } : name === "find" ? { pattern: "**/*" } : {}),
		}, new AbortController().signal, undefined, { cwd, hasUI, ui });
	}

	// Run real positive controls first. Even from the actual .pi installation cwd,
	// enumerate only our inert fixture, never the live installation/runtime tree.
	for (const hasUI of [false, true]) {
		for (const [cwd, target] of [[project, "."], [installation, path.relative(installation, project)]]) {
			for (const name of names) {
				const result = await execute(name, cwd, target, hasUI, "ORDINARY_SEARCH_CWD_MARKER");
				const text = result.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
				assert.match(text, /ordinary\.ts/, `${name} must discover ordinary source from ${cwd}`);
				if (name === "grep") assert.match(text, /ORDINARY_SEARCH_CWD_MARKER/);
				assert.doesNotMatch(text, /DUMMY_CONFIG_ONLY|settings\.json|config\.json|\.agents|\.pi\//);
			}
		}
	}
	assert.deepEqual(dialogs, [], "ordinary and installation searches must not prompt");

	const cases = [
		[".pi", "settings.json"],
		[".pi/nested", "../settings.json"],
		[".agents", "nested/config.json"],
		[".agents/nested", "config.json"],
	];
	// Permission events only: establish the file-read boundary without executing reads.
	for (const [relativeCwd, target] of cases) {
		for (const hasUI of [false, true]) {
			const result = await readHandler({
				type: "tool_call", toolCallId: "nested-config-read", toolName: "read", input: { path: target },
			}, { cwd: path.join(project, relativeCwd), hasUI, ui });
			assert.equal(result?.block, true, `read must deny ${relativeCwd}/${target} with UI=${hasUI}`);
		}
	}
	assert.deepEqual(dialogs, [], "nested configuration reads must not offer consent");

	const traversals: string[] = [];
	const sentinel = new Error("Unexpected directory traversal of nested configuration cwd");
	t.mock.method(fsPromises, "readdir", (...args: unknown[]) => {
		traversals.push(String(args[0]));
		throw sentinel;
	});
	syncBuiltinESMExports();
	const failures: string[] = [];
	try {
		for (const [relativeCwd] of cases) {
			for (const hasUI of [false, true]) {
				for (const name of names) {
					const label = `${name} cwd=${relativeCwd} UI=${hasUI}`;
					try {
						await assert.rejects(() => execute(name, path.join(project, relativeCwd), ".", hasUI), (error: Error) => {
							assert.notEqual(error, sentinel, `${label}: traversal preceded denial`);
							assert.match(error.message, /denied|blocked|not allowed|restricted|forbidden|protected/i);
							assert.doesNotMatch(error.message, /DUMMY_CONFIG_ONLY|no (?:matches|files|results|entries)|empty directory/i);
							return true;
						}, `${label}: protected cwd must fail explicitly`);
					} catch (error) {
						failures.push(`${label}: ${String(error)}`);
					}
				}
			}
		}
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
	assert.deepEqual({ failures, traversals, dialogs }, { failures: [], traversals: [], dialogs: [] },
		"all native searches must deny nested configuration cwd before enumeration, without dialogs");
});
