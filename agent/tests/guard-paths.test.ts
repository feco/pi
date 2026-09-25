import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import registerBlockEnvReads from "../extensions/block-env-reads.ts";
import registerConfirmReads from "../extensions/confirm-reads-outside-cwd.ts";
import registerConfirmWrites from "../extensions/confirm-writes.ts";
import { createReadTool } from "../extensions/node_modules_pi/dist/core/tools/read.js";
import { createEditTool } from "../extensions/node_modules_pi/dist/core/tools/edit.js";
import { createWriteTool } from "../extensions/node_modules_pi/dist/core/tools/write.js";

type Handler = (
	event: { type: "tool_call"; toolCallId: string; toolName: string; input: Record<string, unknown> },
	ctx: { cwd: string; hasUI: boolean; ui: {
		confirm: (title: string, message: string) => Promise<boolean>;
		input: () => Promise<string>;
	} },
) => Promise<{ block?: boolean; reason?: string } | undefined>;

test("file authorization agrees with the normalized target of the installed read/edit/write executors", async (t) => {
	const root = await realpath(await mkdtemp(path.join(fileURLToPath(new URL(".", import.meta.url)), "guard-paths-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cwd = path.join(root, "project");
	const home = path.join(root, "home");
	const outside = path.join(root, "out side/value.txt");
	const inside = path.join(cwd, "ordinary.txt");
	// Real metadata lets authorization validate regular files. Executor content I/O stays inert.
	for (const target of [inside, outside, path.join(home, "value.txt"),
		path.join(cwd, ".env"), path.join(cwd, "credentials.json"),
		path.join(cwd, ".git/config"), path.join(home, ".ssh/config")]) {
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, "before\n");
	}
	t.mock.method(os, "homedir", () => home);
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});

	const handlers: Handler[] = [];
	const api = {
		on(event: string, handler: Handler) { if (event === "tool_call") handlers.push(handler); },
		registerTool() {},
	};
	for (const register of [registerBlockEnvReads, registerConfirmReads, registerConfirmWrites]) {
		register(api as unknown as Parameters<typeof register>[0]);
	}
	assert.equal(handlers.length, 3);

	const accesses: string[] = [];
	const reads: string[] = [];
	const writes: Array<{ target: string; content: string }> = [];
	const directories: string[] = [];
	const operations = {
		async access(target: string) { accesses.push(target); },
		async readFile(target: string) { reads.push(target); return Buffer.from("before\n"); },
		async writeFile(target: string, content: string) { writes.push({ target, content }); },
		async mkdir(target: string) { directories.push(target); },
	};
	const tools = {
		read: createReadTool(cwd, { operations }),
		edit: createEditTool(cwd, { operations }),
		write: createWriteTool(cwd, { operations }),
	};
	// Expected targets are fixture locations, never outputs of the implementation's resolver.
	const cases: Array<{ label: string; input: string; target: string; policy: "inside" | "outside" | "deny" }> = [
		{ label: "ordinary inside", input: "ordinary.txt", target: inside, policy: "inside" },
		{ label: "ordinary outside", input: outside, target: outside, policy: "outside" },
		{ label: "at-prefixed absolute", input: `@${outside}`, target: outside, policy: "outside" },
		{ label: "home expansion", input: "~/value.txt", target: path.join(home, "value.txt"), policy: "outside" },
		{ label: "file URL", input: pathToFileURL(outside).href, target: outside, policy: "outside" },
		{ label: "Unicode space", input: "../out\u00a0side/value.txt", target: outside, policy: "outside" },
		{ label: "encoded env", input: `${pathToFileURL(cwd).href}/%2eenv`, target: path.join(cwd, ".env"), policy: "deny" },
		{ label: "encoded credentials", input: `${pathToFileURL(cwd).href}/%63redentials.json`, target: path.join(cwd, "credentials.json"), policy: "deny" },
		{ label: "encoded git", input: `${pathToFileURL(cwd).href}/%2egit/config`, target: path.join(cwd, ".git/config"), policy: "deny" },
		{ label: "home sensitive directory", input: "~/.ssh/config", target: path.join(home, ".ssh/config"), policy: "deny" },
	];
	const failures: string[] = [];
	for (const toolName of ["read", "edit", "write"] as const) {
		for (const example of cases) {
			for (const mode of ["headless", "refused", "accepted"] as const) {
				accesses.length = reads.length = writes.length = directories.length = 0;
				const dialogs: string[] = [];
				const input = { path: example.input, ...(toolName === "edit"
					? { edits: [{ oldText: "before", newText: "after" }] }
					: toolName === "write" ? { content: "after\n" } : {}) };
				const ctx = {
					cwd, hasUI: mode !== "headless",
					ui: {
						async confirm(title: string, message: string) {
							dialogs.push(`${title}\n${message}`);
							return mode === "accepted";
						},
						async input(): Promise<string> { assert.fail("file decisions must not request extra input"); },
					},
				};
				try {
					let blocked = false;
					for (const handler of handlers) {
						const result = await handler({ type: "tool_call", toolCallId: "path-contract", toolName, input }, ctx);
						if (result?.block) { blocked = true; break; }
					}
					// Match runtime dispatch: never execute a tool after any handler blocks it.
					if (!blocked) {
						const result = await tools[toolName].execute("path-contract", input as never);
						assert.ok(result.content.length > 0, "allowed executor must complete successfully");
					}
					const allowed = example.policy === "inside" || (example.policy === "outside" && mode === "accepted");
					assert.equal(blocked, !allowed, "authorization must match the actual target policy");
					const promptExpected = example.policy === "outside" && mode !== "headless";
					assert.equal(dialogs.length, promptExpected ? 1 : 0, "only valid outside requests may offer consent");
					if (promptExpected) {
						assert.ok(dialogs[0].includes(`**Actual target:** ${JSON.stringify(example.target)}`), "consent must display the normalized executor target");
					}
					assert.deepEqual(accesses, allowed && toolName !== "write" ? [example.target] : []);
					assert.deepEqual(reads, allowed && toolName !== "write" ? [example.target] : []);
					assert.deepEqual(writes, allowed && toolName !== "read" ? [{ target: example.target, content: "after\n" }] : []);
					assert.deepEqual(directories, allowed && toolName === "write" ? [path.dirname(example.target)] : []);
				} catch (error) {
					failures.push(`${toolName} / ${example.label} / ${mode}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
	}
	assert.deepEqual(failures, [], "guards and installed file executors must authorize the same normalized target");
});
