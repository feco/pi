/**
 * Teach Extension
 *
 * Wires Matt Pocock's `teach` skill (https://github.com/mattpocock/skills/tree/main/skills/productivity/teach)
 * into Pi with a topic-folder workflow.
 *
 * Behavior
 * --------
 * 1. Resolves a "teaching root" from the env var `TEACH_WORKSPACE_DIR`
 *    (falls back to $TEACH_WORKSPACE_DIR_DEFAULT or ~/.pi/teaching; if
 *    TEACH_FALLBACK_CWD=true, falls back to the current working directory).
 * 2. Exposes a `teach` tool the LLM can call:
 *      - With no `topic`: lists existing topic folders so the LLM can pick
 *        the right one (handles "continue learning programming" in any
 *        language, including vague phrasings).
 *      - With a `topic`: looks for an existing subfolder whose dash-case name
 *        matches (case-insensitive, accent-stripped). If found, resumes it.
 *        If not, creates a fresh folder with the standard teach layout.
 *      - With `mode="list"`: always returns the list, never creates.
 * 3. Exposes a `/teach [topic]` slash command. With no args, it triggers a
 *    "list topics" round-trip; with a topic, it picks-or-creates and starts.
 * 4. Hooks `before_agent_start` to inject a system message addendum that
 *    pins the active topic path, so the model never has to guess.
 *
 * Intent recognition is left entirely to the LLM — no regex on the user
 * prompt, so it works in any language (French "apprends-moi le coréen",
 * Spanish "enséñame Rust", etc.).
 *
 * Install
 * -------
 * This file already lives at `~/.pi/agent/extensions/teach.ts` and is
 * auto-loaded. The forked skill must live at the path TEACH_SKILL_PATH
 * points to (default: $HOME/.pi/agent/skills/teach/SKILL.md).
 *
 * Environment variables
 * ---------------------
 *   TEACH_WORKSPACE_DIR         Root folder containing one subfolder per topic.
 *                               Default: $TEACH_WORKSPACE_DIR_DEFAULT or ~/.pi/teaching
 *   TEACH_WORKSPACE_DIR_DEFAULT Optional secondary fallback for the teaching root.
 *   TEACH_SKILL_PATH            Absolute path to a teach SKILL.md to load.
 *                               Default: $HOME/.pi/agent/skills/teach/SKILL.md
 *   TEACH_FALLBACK_CWD          If "true", fall back to ctx.cwd when
 *                               TEACH_WORKSPACE_DIR is unset. Default: false.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Config / helpers
// ---------------------------------------------------------------------------

const TOOL_NAME = "teach";
const CMD_NAME = "teach";
const STATE_CUSTOM_TYPE = "teach-active-topic";

/** "Async JS Patterns" -> "async-js-patterns" — strip diacritics, dash-case, cap at 80. */
function dashCase(input: string): string {
	return (
		input
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[\u0300-\u036f]/g, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80) || "untitled-topic"
	);
}

/** Normalize a topic string for fuzzy folder matching. */
function normalize(input: string): string {
	return dashCase(input);
}

function resolveTeachingRoot(): string {
	const fromEnv = process.env.TEACH_WORKSPACE_DIR?.trim();
	if (fromEnv) return resolve(fromEnv);

	const fromDefaultEnv = process.env.TEACH_WORKSPACE_DIR_DEFAULT?.trim();
	if (fromDefaultEnv) return resolve(fromDefaultEnv);

	if (process.env.TEACH_FALLBACK_CWD === "true") {
		return process.cwd();
	}

	return resolve(homedir(), ".pi", "teaching");
}

function resolveSkillPath(): string {
	const fromEnv = process.env.TEACH_SKILL_PATH?.trim();
	if (fromEnv) return resolve(fromEnv);
	return resolve(homedir(), ".pi", "agent", "skills", "teach", "SKILL.md");
}

/** Find an existing topic subfolder matching the given topic (case-insensitive, dash-normalized). */
function findExistingTopicDir(root: string, topic: string): string | null {
	if (!existsSync(root)) return null;
	const wanted = normalize(topic);
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return null;
	}
	for (const entry of entries) {
		const full = join(root, entry);
		try {
			if (!statSync(full).isDirectory()) continue;
		} catch {
			continue;
		}
		if (normalize(entry) === wanted) return full;
	}
	return null;
}

/** Create the standard teach layout inside a fresh topic folder. */
function createTopicDir(root: string, topic: string): string {
	const dirName = dashCase(topic);
	const dir = join(root, dirName);
	mkdirSync(dir, { recursive: true });
	mkdirSync(join(dir, "reference"), { recursive: true });
	mkdirSync(join(dir, "lessons"), { recursive: true });
	mkdirSync(join(dir, "learning-records"), { recursive: true });

	const mission = `# Mission\n\n> Topic: **${topic}**\n\n> _Why are you learning this? Replace this paragraph with your motivation._\n`;
	const resources = `# Resources\n\n> Curated, high-trust sources for **${topic}**. Add links and one-line annotations.\n`;
	const notes = `# Notes\n\n> Scratchpad. Jot preferences, follow-ups, and decisions about how you want to be taught.\n`;

	if (!existsSync(join(dir, "MISSION.md"))) writeFileSync(join(dir, "MISSION.md"), mission);
	if (!existsSync(join(dir, "RESOURCES.md"))) writeFileSync(join(dir, "RESOURCES.md"), resources);
	if (!existsSync(join(dir, "NOTES.md"))) writeFileSync(join(dir, "NOTES.md"), notes);

	return dir;
}

/** List existing topic folders, with a one-line preview from MISSION.md if present. */
function listTopicDirs(root: string): Array<{ dir: string; name: string; preview: string }> {
	if (!existsSync(root)) return [];
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return [];
	}
	const out: Array<{ dir: string; name: string; preview: string }> = [];
	for (const entry of entries) {
		const full = join(root, entry);
		try {
			if (!statSync(full).isDirectory()) continue;
		} catch {
			continue;
		}
		let preview = "";
		const missionPath = join(full, "MISSION.md");
		if (existsSync(missionPath)) {
			try {
				const text = readFileSync(missionPath, "utf8");
				// First non-heading, non-empty, non-blockquote line — quick topic blurb.
				preview = text
					.split("\n")
					.map((l) => l.trim())
					.find(
						(l) =>
							l.length > 0 &&
							!l.startsWith("#") &&
							!l.startsWith(">") &&
							!l.startsWith("-") &&
							!l.startsWith("*"),
					) ?? "";
				if (preview.length > 120) preview = preview.slice(0, 117) + "...";
			} catch {
				/* ignore */
			}
		}
		out.push({ dir: full, name: entry, preview });
	}
	// Stable, predictable order.
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

/** Persist the active topic for this session so we can re-inject it on each turn. */
function rememberTopic(pi: ExtensionAPI, topic: string, dir: string) {
	pi.appendEntry(STATE_CUSTOM_TYPE, { topic, dir, ts: Date.now() });
}

function recallTopic(ctx: ExtensionContext): { topic: string; dir: string } | null {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "custom" && entry.customType === STATE_CUSTOM_TYPE) {
			const data = entry.data as { topic: string; dir: string } | undefined;
			if (data?.topic && data?.dir) return data;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Tool: pick, create, or list
// ---------------------------------------------------------------------------

const TeachToolParams = Type.Object({
	topic: Type.Optional(
		Type.String({
			description:
				"The topic the user wants to learn. Omit or leave empty to list existing topic folders so you can pick the right one (use this when the user's request is vague, like 'continue my learning of programming languages'). Will be dash-cased to form the folder name (e.g. 'coréen' -> 'coreen', 'Async JS' -> 'async-js').",
		}),
	),
	mode: Type.Optional(
		StringEnum(["auto", "continue", "create", "list"] as const, {
			description:
				"'auto' (default for a non-empty topic): continue if a matching folder exists, otherwise create. 'continue' = error if missing. 'create' = always create a new folder (errors if one already exists with the same name). 'list' = always return the list of existing topic folders, never create.",
		}),
	),
});

type TeachToolResult =
	| {
			kind: "topic";
			topic: string;
			dir: string;
			status: "continued" | "created";
			root: string;
			skillPath: string;
	  }
	| {
			kind: "list";
			existing: Array<{ dir: string; name: string; preview: string }>;
			root: string;
			skillPath: string;
	  };

/**
 * Core logic. Exposed as a function so both the tool and the slash command
 * can share it.
 */
async function pickOrCreateTopic(
	topic: string | undefined,
	mode: "auto" | "continue" | "create" | "list",
	_ctx: ExtensionContext,
): Promise<TeachToolResult> {
	const root = resolveTeachingRoot();
	mkdirSync(root, { recursive: true });
	const skillPath = resolveSkillPath();

	if (mode === "list" || !topic || !topic.trim()) {
		return {
			kind: "list",
			existing: listTopicDirs(root),
			root,
			skillPath,
		};
	}

	const trimmed = topic.trim();

	if (mode === "create") {
		const existing = findExistingTopicDir(root, trimmed);
		if (existing) {
			throw new Error(
				`A topic folder already exists at ${existing}. Use mode="auto" or mode="continue" to resume it, or pick a different topic name.`,
			);
		}
		const dir = createTopicDir(root, trimmed);
		return { kind: "topic", topic: trimmed, dir, status: "created", root, skillPath };
	}

	if (mode === "continue") {
		const existing = findExistingTopicDir(root, trimmed);
		if (!existing) {
			// Surface the list so the LLM can see what's available instead of
			// failing blind in "continue" mode.
			const list = listTopicDirs(root);
			const listStr =
				list.length === 0
					? "(no existing topics — call again with mode='create' or mode='auto')"
					: list
							.map((t) => `  - ${t.name}${t.preview ? ` — ${t.preview}` : ""}`)
							.join("\n");
			throw new Error(
				`No existing topic folder for "${trimmed}" under ${root}.\n\nExisting topics:\n${listStr}`,
			);
		}
		return {
			kind: "topic",
			topic: trimmed,
			dir: existing,
			status: "continued",
			root,
			skillPath,
		};
	}

	// auto
	const existing = findExistingTopicDir(root, trimmed);
	if (existing) {
		return {
			kind: "topic",
			topic: trimmed,
			dir: existing,
			status: "continued",
			root,
			skillPath,
		};
	}
	const dir = createTopicDir(root, trimmed);
	return { kind: "topic", topic: trimmed, dir, status: "created", root, skillPath };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function teachExtension(pi: ExtensionAPI) {
	// 1) Custom tool the LLM can call ---------------------------------------
	pi.registerTool({
		name: TOOL_NAME,
		label: "Teach",
		description:
			"Pick, create, or list per-topic teaching workspaces under TEACH_WORKSPACE_DIR. " +
			"Call this at the start of any teaching session. With no `topic`, returns the list of existing topic folders (each with a one-line preview from MISSION.md) so you can match vague user requests like 'continue learning programming' or 'apprends-moi le coréen' to the right existing folder — or create a new one. " +
			"With a `topic`, looks for a matching folder (case-insensitive, accent-stripped, dash-normalized — so 'coréen', 'coreen', and 'Coréen' all match `coreen`); resumes it if found, creates it otherwise. " +
			"Returns the absolute path which all subsequent file writes should use.",
		promptSnippet:
			"Pick, create, or list per-topic teaching workspaces under TEACH_WORKSPACE_DIR. Call this at the start of any teaching session.",
		promptGuidelines: [
			"Call the teach tool at the start of any teaching turn. The user's request is in their language — translate the *intent* to a topic string. Pass an empty topic (or mode='list') if the user wants to continue an existing topic but you need to know what's there.",
			"If the tool returns a list (no topic given), match the user's intent against the existing folders using MISSION.md previews. If a clear match exists, call teach again with that exact topic. If no match, call teach with the new topic and mode='auto' (or 'create') to start fresh.",
			"When you receive a `topic` result, write all teach files (MISSION.md, RESOURCES.md, NOTES.md, lessons/*.html, learning-records/*.md, reference/*.html) inside the returned `dir` and nowhere else.",
		],
		parameters: TeachToolParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await pickOrCreateTopic(params.topic, params.mode ?? "auto", ctx);

			if (result.kind === "list") {
				const list = result.existing;
				const lines = [
					list.length === 0
						? `No existing topic folders under ${result.root}.`
						: `Existing topic folders under ${result.root}:`,
					...list.map(
						(t) => `  - ${t.name}${t.preview ? ` — ${t.preview}` : ""}\n    ${t.dir}`,
					),
					``,
					`Pick the matching topic and call the teach tool again with topic="<exact-folder-name>" and mode="auto" (or "continue" / "create").`,
					`Or, to start a new topic, call teach with topic="<new topic>" and mode="auto".`,
				];
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: result,
				};
			}

			rememberTopic(pi, result.topic, result.dir);
			return {
				content: [
					{
						type: "text",
						text: [
							`Teaching workspace ${result.status === "created" ? "created" : "resumed"} for topic "${result.topic}".`,
							``,
							`Root: ${result.root}`,
							`Topic dir: ${result.dir}`,
							`Status: ${result.status}`,
							``,
							`Write all teach files (MISSION.md, RESOURCES.md, NOTES.md, lessons/*.html, learning-records/*.md, reference/*.html) inside:`,
							result.dir,
							``,
							`Skill spec loaded from: ${result.skillPath}`,
						].join("\n"),
					},
				],
				details: result,
			};
		},
	});

	// 2) Slash command ------------------------------------------------------
	pi.registerCommand(CMD_NAME, {
		description:
			"Start, resume, or list teaching topics. Usage: /teach <topic> (or just /teach to see existing topics).",
		handler: async (args, ctx) => {
			const topic = (args ?? "").trim();

			if (!topic) {
				// No topic: list, and let the LLM pick from the list.
				const root = resolveTeachingRoot();
				mkdirSync(root, { recursive: true });
				const existing = listTopicDirs(root);
				if (existing.length === 0) {
					if (ctx.hasUI) {
						ctx.ui.notify(
							`No teaching topics yet under ${root}. Use /teach <topic> to start one.`,
							"info",
						);
					} else {
						process.stdout.write(
							`teach: no topics under ${root}. Use /teach <topic> to start one.\n`,
						);
					}
					return;
				}

				const summary = existing
					.map((t) => `  - ${t.name}${t.preview ? ` — ${t.preview}` : ""}`)
					.join("\n");

				if (ctx.hasUI) {
					ctx.ui.notify(
						`Existing topics:\n${summary}\n\nType /teach <topic> to resume, or describe what you want to learn.`,
						"info",
					);
				} else {
					process.stdout.write(`Existing topics:\n${summary}\n`);
				}

				// Hand the LLM the list so it can pick.
				pi.sendUserMessage(
					`Call the teach tool with mode="list" to see existing topics, then pick the one that matches my request and call teach again with that exact topic. If none match, call teach with a new topic name and mode="auto" to create a fresh workspace.`,
				);
				return;
			}

			// Topic given: pick-or-create directly.
			const result = await pickOrCreateTopic(topic, "auto", ctx);
			if (result.kind === "list") {
				// Should not happen when topic is non-empty, but guard anyway.
				if (ctx.hasUI) ctx.ui.notify("Unexpected: empty result with topic.", "warning");
				return;
			}
			rememberTopic(pi, result.topic, result.dir);

			if (ctx.hasUI) {
				ctx.ui.notify(
					`${result.status === "created" ? "Created" : "Resumed"} topic "${result.topic}" at ${result.dir}`,
					"info",
				);
			} else {
				process.stdout.write(
					`teach: ${result.status} "${result.topic}" -> ${result.dir}\n`,
				);
			}

			const kickoff = `Use the teach tool to confirm/refresh the workspace for "${result.topic}", then begin teaching me ${result.topic}. Start by clarifying the mission if MISSION.md is empty, otherwise read the existing state (MISSION.md, RESOURCES.md, learning-records/*.md) and propose the next lesson.`;
			pi.sendUserMessage(kickoff);
		},
	});

	// 3) Inject a per-turn addendum pinning the active topic path -----------
	pi.on("before_agent_start", async (_event, ctx) => {
		const active = recallTopic(ctx);
		if (!active) return; // no active topic — let the agent run normally.

		const root = resolveTeachingRoot();
		const skillPath = resolveSkillPath();

		const lines = [
			"",
			"---",
			`[teach extension] Active teaching topic: "${active.topic}"`,
			`[teach extension] Write ALL teach files (MISSION.md, RESOURCES.md, NOTES.md, lessons/*.html, learning-records/*.md, reference/*.html) inside this directory and nowhere else:`,
			active.dir,
			``,
			`[teach extension] TEACH_WORKSPACE_DIR root: ${root}`,
			`[teach extension] Follow the teach skill spec at: ${skillPath}`,
			`[teach extension] If you need to write outside the topic dir, ask the user first.`,
			`[teach extension] If the user wants to switch or continue a different topic, call the teach tool with no topic (or mode="list") to see existing folders.`,
		];

		return {
			systemPrompt: _event.systemPrompt + "\n" + lines.join("\n"),
		};
	});
}
