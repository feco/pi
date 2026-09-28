import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import registerConfirmWrites from "../extensions/confirm-writes.ts";

type SearchTool = {
	name: string;
	execute: (id: string, input: Record<string, unknown>, signal: AbortSignal, onUpdate: undefined,
		ctx: { cwd: string; hasUI: boolean; ui: Record<string, () => Promise<never>> },
	) => Promise<{ content: Array<{ type: string; text?: string }> }>;
};
const names = ["grep", "find", "ls"] as const;

async function fixture(t: TestContext, files: Record<string, string>) {
	const root = await mkdtemp(path.join(fileURLToPath(new URL(".", import.meta.url)), "search-ignore-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const [name, content] of Object.entries(files)) {
		await mkdir(path.dirname(path.join(root, name)), { recursive: true });
		await writeFile(path.join(root, name), content);
	}
	const tools = new Map<string, SearchTool>();
	registerConfirmWrites({
		on() {}, registerTool(tool: SearchTool) { tools.set(tool.name, tool); },
	} as unknown as Parameters<typeof registerConfirmWrites>[0]);
	for (const name of names) assert.ok(tools.has(name));
	return {
		root,
		async search(name: typeof names[number], target = ".", extra: Record<string, unknown> = {}) {
			const result = await tools.get(name)!.execute("ignore-contract", {
				path: target, ...(name === "grep" ? { pattern: "SEARCH_MARKER" } : name === "find" ? { pattern: "**/*" } : {}), ...extra,
			}, new AbortController().signal, undefined, {
				cwd: root, hasUI: false,
				ui: { async confirm() { assert.fail("search must not prompt"); }, async input() { assert.fail("search must not prompt"); } },
			});
			return result.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
		},
	};
}

test("search respects ordered ignore exceptions without blocking ordinary source", async (t) => {
	const { search } = await fixture(t, {
		".gitignore": "*.log\n!example.log\n",
		"source.ts": "SEARCH_MARKER\n",
		"example.log": "SEARCH_MARKER\n",
		"hidden.log": "SEARCH_MARKER\n",
		"src/ordinary.ts": "SEARCH_MARKER\n",
	});
	for (const name of names) {
		const output = await search(name);
		assert.match(output, /source\.ts/);
		assert.match(output, /example\.log/);
		assert.doesNotMatch(output, /hidden\.log/);
		assert.match(await search(name, "src"), /ordinary\.ts/);
	}
	assert.match(await search("grep", "example.log"), /SEARCH_MARKER/);
	await assert.rejects(() => search("grep", "hidden.log"), /ignored target/);
});

test("Git-ignore escaping, character classes, whitespace, and rule order are supported", async (t) => {
	const { search } = await fixture(t, {
		".gitignore": "# comment\r\n\r\n\\#hash.txt\r\n\\!bang.txt\r\nspace\\ .txt\r\ntrimmed.txt   \r\n leading.txt\r\n[ab].tmp\r\nbrace{a,b}.txt\r\n*.log\r\n!keep.log\r\nkeep.log\r\nUPPER.txt\r\n",
		"source.ts": "SEARCH_MARKER\n",
		"#hash.txt": "SEARCH_MARKER\n", "!bang.txt": "SEARCH_MARKER\n",
		"space .txt": "SEARCH_MARKER\n", "trimmed.txt": "SEARCH_MARKER\n", " leading.txt": "SEARCH_MARKER\n",
		"a.tmp": "SEARCH_MARKER\n", "b.tmp": "SEARCH_MARKER\n", "c.tmp": "SEARCH_MARKER\n",
		"brace{a,b}.txt": "SEARCH_MARKER\n", "bracea.txt": "SEARCH_MARKER\n",
		"keep.log": "SEARCH_MARKER\n", "upper.txt": "SEARCH_MARKER\n",
	});
	for (const name of names) {
		const output = await search(name);
		for (const visible of ["source.ts", "c.tmp", "bracea.txt", "upper.txt"]) assert.ok(output.includes(visible), `${name}: ${visible}`);
		for (const hidden of ["#hash.txt", "!bang.txt", "space .txt", "trimmed.txt", " leading.txt", "a.tmp", "b.tmp", "brace{a,b}.txt", "keep.log"]) {
			assert.ok(!output.includes(hidden), `${name} must exclude ${hidden}`);
			await assert.rejects(() => search("grep", hidden), /ignored target/);
		}
	}
});

test("nested policies override matching ancestor rules without affecting sibling directories", async (t) => {
	const { search } = await fixture(t, {
		".gitignore": "*.txt\n!keep.txt\n",
		"keep.txt": "SEARCH_MARKER\n",
		"nested/.gitignore": "!local.txt\nkeep.txt\n/local-only.ts\n",
		"nested/local.txt": "SEARCH_MARKER\n", "nested/keep.txt": "SEARCH_MARKER\n",
		"nested/hidden.txt": "SEARCH_MARKER\n", "nested/local-only.ts": "SEARCH_MARKER\n",
		"nested/deep/local-only.ts": "SEARCH_MARKER\n", "sibling/local.txt": "SEARCH_MARKER\n",
	});
	for (const name of ["grep", "find"] as const) {
		const output = await search(name);
		assert.ok(output.includes("keep.txt"));
		assert.ok(output.includes("nested/local.txt"));
		assert.ok(output.includes("nested/deep/local-only.ts"));
		for (const hidden of ["nested/keep.txt", "nested/hidden.txt", "nested/local-only.ts", "sibling/local.txt"]) assert.ok(!output.includes(hidden));
	}
	for (const name of names) {
		const output = await search(name, "nested");
		assert.ok(output.includes("nested/local.txt"));
		assert.doesNotMatch(output, /nested\/(?:keep\.txt|hidden\.txt|local-only\.ts)/);
	}
	assert.match(await search("grep", "nested/local.txt"), /SEARCH_MARKER/);
	await assert.rejects(() => search("grep", "nested/keep.txt"), /ignored target/);
});

test("nested directory exceptions reopen descendants without cancelling file rules or leaking to siblings", async (t) => {
	const { search } = await fixture(t, {
		".gitignore": "foo/*\n*.log\n",
		"foo/.gitignore": "!bar/\n!special\\[1\\]/\n!specialx/\n",
		"foo/bar/visible.ts": "SEARCH_MARKER\n", "foo/bar/hidden.log": "SEARCH_MARKER\n",
		"foo/bar/deep/visible.ts": "SEARCH_MARKER\n", "foo/closed/hidden.ts": "SEARCH_MARKER\n",
		"foo/special[1]/visible.ts": "SEARCH_MARKER\n", "foo/specialx/visible.ts": "SEARCH_MARKER\n",
	});
	for (const name of ["grep", "find"] as const) {
		const output = await search(name);
		for (const visible of ["foo/bar/visible.ts", "foo/bar/deep/visible.ts", "foo/special[1]/visible.ts", "foo/specialx/visible.ts"]) {
			assert.ok(output.includes(visible), `${name} must discover ${visible}`);
			assert.match(await search("grep", visible), /SEARCH_MARKER/);
		}
		assert.doesNotMatch(output, /hidden\.(?:ts|log)/);
	}
	for (const name of names) {
		assert.match(await search(name, "foo/bar"), /visible\.ts/);
		await assert.rejects(() => search(name, "foo/closed"), /ignored target/);
	}
	await assert.rejects(() => search("grep", "foo/bar/hidden.log"), /ignored target/);
});

test("directory exclusion blocks descendant exceptions while globstars and anchored rules preserve other paths", async (t) => {
	const { search } = await fixture(t, {
		".gitignore": "closed/\n!closed/kept.ts\n/root.ts\n/src/**/generated?.ts\ncache/\n",
		"root.ts": "SEARCH_MARKER\n", "source.ts": "SEARCH_MARKER\n",
		"closed/.gitignore": "!*\n", "closed/kept.ts": "SEARCH_MARKER\n",
		"src/root.ts": "SEARCH_MARKER\n", "src/generated1.ts": "SEARCH_MARKER\n",
		"src/deep/generated2.ts": "SEARCH_MARKER\n", "src/deep/ordinary.ts": "SEARCH_MARKER\n",
		"cache/hidden.ts": "SEARCH_MARKER\n", "src/cache": "SEARCH_MARKER\n",
	});
	for (const name of ["grep", "find"] as const) {
		const output = await search(name);
		for (const visible of ["source.ts", "src/root.ts", "src/deep/ordinary.ts", "src/cache"]) assert.ok(output.includes(visible));
		assert.doesNotMatch(output, /closed|generated[12]|cache\/hidden/);
	}
	for (const name of names) {
		await assert.rejects(() => search(name, "closed"), /ignored target/);
		assert.match(await search(name, "src/deep"), /ordinary\.ts/);
	}
	for (const target of ["root.ts", "closed/kept.ts", "cache/hidden.ts", "src/generated1.ts", "src/deep/generated2.ts"]) {
		await assert.rejects(() => search("grep", target), /ignored target/);
	}
});

test("ignore exceptions cannot reopen secrets, protected directories, links, or outside targets", async (t) => {
	const files = Object.fromEntries([
		"ordinary.ts", ".env.example", ".env", "credentials.json", "private.key", ".git/hidden.ts", ".aws/hidden.ts",
		".pi/settings.json", ".agents/settings.json", ".pi-subagents/hidden.ts", "node_modules/hidden.ts", "hard-source.ts",
	].map((name) => [name, "SEARCH_MARKER\n"]));
	const { root, search } = await fixture(t, { ...files, ".gitignore": "*\n!*\n" });
	await link(path.join(root, "hard-source.ts"), path.join(root, "hard-linked.ts"));
	await symlink(path.join(root, "ordinary.ts"), path.join(root, "symbolic.ts"));
	await symlink(path.dirname(root), path.join(root, "outside-link"));
	for (const name of names) {
		const output = await search(name);
		assert.match(output, /ordinary\.ts/);
		assert.match(name === "find" ? await search(name, ".", { pattern: ".env.example" }) : output, /\.env\.example/);
		assert.doesNotMatch(output, /credentials|private\.key|hidden\.ts|settings\.json|hard-|symbolic|outside-link|node_modules|\.pi|\.aws|\.git(?:\/|$)|\.env(?:\s|:|$)/);
		for (const target of [".env", "credentials.json", "private.key", ".git", ".aws", ".pi", ".agents", ".pi-subagents", "node_modules", "hard-linked.ts", "symbolic.ts", "outside-link", ".."]) {
			await assert.rejects(() => search(name, target), /Search denied/);
		}
	}
});

test("unsafe nested ignore policies report incomplete search and explicit targets fail closed", async (t) => {
	const { root, search } = await fixture(t, {
		"source.ts": "SEARCH_MARKER\n",
		"bad/hidden.ts": "SEARCH_MARKER\n",
		"policy.txt": "*.ts\n",
	});
	await symlink(path.join(root, "policy.txt"), path.join(root, "bad/.gitignore"));
	for (const name of ["grep", "find"] as const) {
		const output = await search(name);
		assert.match(output, /source\.ts/);
		assert.match(output, /Warning: incomplete search/);
		assert.doesNotMatch(output, /hidden\.ts/);
		const empty = await search(name, ".", { pattern: "absent-marker" });
		assert.match(empty, /Warning: incomplete search/);
		assert.notEqual(empty, "No results");
	}
	for (const name of names) await assert.rejects(() => search(name, "bad"), /unsafe ignore policy/);
	await assert.rejects(() => search("grep", "bad/hidden.ts"), /unsafe ignore policy/);
	await writeFile(path.join(root, "source.ts"), `${"SEARCH_MARKER".padEnd(1000, "x")}\n`.repeat(100));
	const bounded = await search("grep", ".", { limit: 1000 });
	assert.match(bounded, /^Warning: incomplete search/);
	assert.ok(Buffer.byteLength(bounded) <= 65_536, "warning must fit inside the output byte cap");
});

test("binary, oversized, hard-linked, and nonregular ignore policies remain fail-closed", async (t) => {
	for (const mode of ["binary", "oversized", "hard-linked", "directory"] as const) {
		await t.test(mode, async (t) => {
			const { root, search } = await fixture(t, { "source.ts": "SEARCH_MARKER\n", "bad/hidden.ts": "SEARCH_MARKER\n" });
			const policy = path.join(root, "bad/.gitignore");
			if (mode === "directory") await mkdir(policy);
			else if (mode === "hard-linked") {
				await writeFile(path.join(root, "policy.txt"), "*.ts\n");
				await link(path.join(root, "policy.txt"), policy);
			} else await writeFile(policy, mode === "binary" ? "*.ts\0\n" : " ".repeat(1_048_577));
			for (const name of ["grep", "find"] as const) {
				const output = await search(name);
				assert.match(output, /^Warning: incomplete search/);
				assert.match(output, /source\.ts/);
				assert.doesNotMatch(output, /hidden\.ts/);
			}
			for (const name of names) await assert.rejects(() => search(name, "bad"), /(?:unsafe|unreadable) ignore policy/);
			await assert.rejects(() => search("grep", "bad/hidden.ts"), /(?:unsafe|unreadable) ignore policy/);
		});
	}
});
