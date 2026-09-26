import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { expandPath, resolveToCwd } from "../extensions/lib/path-utils.ts";

test("normalizes file-tool paths without an installed Pi package", () => {
	const cwd = "/project";
	for (const [input, expanded, resolved] of [
		["file.txt", "file.txt", "/project/file.txt"],
		["../outside.txt", "../outside.txt", "/outside.txt"],
		["@/outside.txt", "/outside.txt", "/outside.txt"],
		["@@file.txt", "@file.txt", "/project/@file.txt"],
		["~", homedir(), homedir()],
		["@~/file.txt", path.join(homedir(), "file.txt"), path.join(homedir(), "file.txt")],
		["~someone/file.txt", "~someone/file.txt", "/project/~someone/file.txt"],
		["@file:///tmp/out%20side.txt", "/tmp/out side.txt", "/tmp/out side.txt"],
		["/tmp/../file.txt", "/tmp/../file.txt", "/file.txt"],
		[" file.txt ", " file.txt ", "/project/ file.txt "],
	]) {
		assert.equal(expandPath(input), expanded, input);
		assert.equal(resolveToCwd(input, cwd), resolved, input);
	}
	for (const space of "\u00a0\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000") {
		assert.equal(resolveToCwd(`out${space}side.txt`, cwd), "/project/out side.txt");
	}
	assert.equal(resolveToCwd("file.txt", "~/project"), path.join(homedir(), "project/file.txt"));
	assert.equal(resolveToCwd("file.txt", "/out\u00a0side"), "/out\u00a0side/file.txt");
	assert.equal(resolveToCwd("file.txt", "@project"), path.resolve("@project/file.txt"));
	assert.throws(() => expandPath("file:///tmp/%zz"), URIError);
	assert.throws(() => expandPath("file:///tmp/a%2fb"));
});
