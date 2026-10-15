import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Pi agents live in agent/agents and Claude Code agents in agent/claude-agents.
// Each agent keeps one prompt: only the harness-specific frontmatter may differ.
const agentDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const piDir = path.join(agentDir, "agents");
const claudeDir = path.join(agentDir, "claude-agents");

type Agent = { description: string; body: string };

async function loadAgents(dir: string): Promise<Map<string, Agent>> {
	const agents = new Map<string, Agent>();
	for (const file of (await readdir(dir)).filter((name) => name.endsWith(".md")).sort()) {
		const text = await readFile(path.join(dir, file), "utf8");
		const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
		assert.ok(match, `${file} must start with a frontmatter block`);
		const description = /^description:\s*(.*)$/m.exec(match[1])?.[1] ?? "";
		agents.set(path.basename(file, ".md"), { description, body: match[2].trim() });
	}
	return agents;
}

test("Pi and Claude Code define the same agents with the same description and prompt", async () => {
	const pi = await loadAgents(piDir);
	const claude = await loadAgents(claudeDir);
	assert.deepEqual([...pi.keys()], [...claude.keys()], "both harnesses must define the same agent names");
	for (const [name, agent] of pi) {
		assert.deepEqual(claude.get(name), agent, `${name}: description and prompt must match across harnesses`);
	}
});
