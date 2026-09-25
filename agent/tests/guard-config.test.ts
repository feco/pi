import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import registerBlockEnvReads from "../extensions/block-env-reads.ts";
import registerConfirmReads from "../extensions/confirm-reads-outside-cwd.ts";
import registerConfirmWrites from "../extensions/confirm-writes.ts";

type Handler = (
	event: { type: "tool_call"; toolCallId: string; toolName: string; input: Record<string, unknown> },
	ctx: { cwd: string; hasUI: boolean; ui: {
		confirm: (title: string, message: string) => Promise<boolean>;
		input: () => Promise<string>;
	} },
) => Promise<{ block?: boolean; reason?: string } | undefined>;

test("global instruction mutations require UI consent even when cwd encloses the active installation", async (t) => {
	const handlers: Handler[] = [];
	const api = {
		on(event: string, handler: Handler) { if (event === "tool_call") handlers.push(handler); },
		registerTool() {},
	};
	// Match pi-subagent-safe registration order and stop dispatch at the first denial.
	for (const register of [registerBlockEnvReads, registerConfirmReads, registerConfirmWrites]) {
		register(api as unknown as Parameters<typeof register>[0]);
	}
	assert.equal(handlers.length, 3);
	const testsDir = await realpath(fileURLToPath(new URL(".", import.meta.url)));
	const agentDir = path.dirname(testsDir);
	const cwd = path.dirname(agentDir);
	const fixture = await mkdtemp(path.join(testsDir, "guard-config-"));
	t.after(() => rm(fixture, { recursive: true, force: true }));

	// Independent list of global instruction names consumed by resource-loader.js.
	// Missing instruction files still matter: write can create them without a prior read.
	const cases: Array<{ toolName: "write" | "edit"; input: Record<string, unknown>; protected: boolean }> = [
		...[
			"APPEND_SYSTEM.md", "AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD",
		].map((name) => ({
			toolName: "write" as const,
			input: { path: path.join(agentDir, name), content: "INERT_PROPOSED_INSTRUCTION\n" },
			protected: true,
		})),
		{
			toolName: "edit",
			// Permission-only replacement control; never read SYSTEM.md to choose oldText.
			input: { path: path.join(agentDir, "SYSTEM.md"), oldText: "INERT_OLD_TEXT", newText: "INERT_NEW_TEXT" },
			protected: true,
		},
		{
			toolName: "write",
			input: { path: path.join(fixture, "ordinary.txt"), content: "INERT_ORDINARY_CONTENT\n" },
			protected: false,
		},
	];
	const failures: string[] = [];
	for (const example of cases) {
		for (const mode of ["headless", "refused", "accepted"] as const) {
			let confirmations = 0;
			let blocked = false;
			const label = `${example.toolName} ${example.input.path} / ${mode}`;
			try {
				// Authorization events ONLY: no file executor is registered or invoked,
				// and no live configuration content is read, created, or changed.
				for (const handler of handlers) {
					const result = await handler({
						type: "tool_call", toolCallId: "global-instruction-consent", toolName: example.toolName,
						input: { ...example.input },
					}, {
						cwd, hasUI: mode !== "headless",
						ui: {
							async confirm() { confirmations++; return mode === "accepted"; },
							async input(): Promise<string> { assert.fail("file consent must not request extra input"); },
						},
					});
					if (result?.block === true) { blocked = true; break; }
				}
				const expectedDialogs = example.protected && mode !== "headless" ? 1 : 0;
				if (confirmations !== expectedDialogs) failures.push(`${label}: expected ${expectedDialogs} dialogs, got ${confirmations}`);
				const expectedBlock = example.protected && mode !== "accepted";
				if (blocked !== expectedBlock) failures.push(`${label}: expected block=${expectedBlock}, got ${blocked}`);
			} catch (error) {
				failures.push(`${label}: expected a permission decision, got ${String(error)}`);
			}
		}
	}
	assert.deepEqual(failures, [], "global instruction mutations need exactly one UI consent; ordinary writes remain allowed");
});
