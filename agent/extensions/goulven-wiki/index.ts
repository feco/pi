import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

import { loadConfig, loadState, saveState, type GoulvenState } from "./lib/config.js";
import { scanInputDir } from "./lib/scanner.js";
import { unifiedSearch } from "./lib/search.js";
import { buildSearchIndex } from "./lib/indexer.js";
import { generateWikiPages } from "./lib/wiki.js";
import { ensurePurposeFile, readPurpose, rebuildIndex, appendLog } from "./lib/meta.js";
import { writeWikiPage } from "./lib/write.js";
import { editWikiPage, type WikiEdit } from "./lib/edit.js";

const NOT_CONFIGURED_MSG =
  "Goulven Wiki is not configured yet. Set these environment variables, then restart Pi (or /reload):\n\n" +
  "```bash\n" +
  "export LLM_WIKI_INPUT_DIR=\"$HOME/Notes\"            # where your raw .md notes live\n" +
  "export LLM_WIKI_OUTPUT_DIR=\"$HOME/Nextcloud/Wiki\"  # Nextcloud-synced wiki output\n" +
  "```";

export default function (pi: ExtensionAPI) {
  // ── Load config ──────────────────────────────────────────
  // The extension is DORMANT when env vars are missing: no error, no status,
  // hooks simply skip. Tools return a friendly setup message if called.
  let config: ReturnType<typeof loadConfig> | null = null;
  let state: GoulvenState = { version: 1, files: {}, lastScan: null };

  try {
    config = loadConfig();
    state = loadState(config.outputDir);
  } catch {
    config = null; // dormant
  }

  // ── Block host edit/write on raw notes ─────────────────
  // Raw notes in LLM_WIKI_INPUT_DIR are immutable source material. The agent
  // should synthesize into wiki pages and edit those instead. This hook stops
  // accidental (or over-eager) use of the host edit/write tools on raw notes.
  pi.on("tool_call", async (event, ctx) => {
    if (!config) return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;

    const rawPath = event.input?.path;
    if (typeof rawPath !== "string") return;

    const expanded = rawPath.replace(/^~/, homedir());
    const resolved = resolve(expanded).replace(/\\/g, "/");
    const inputRoot = config.inputDir.replace(/\\/g, "/");

    if (resolved === inputRoot || resolved.startsWith(inputRoot + "/")) {
      return {
        block: true,
        reason:
          "🚫 Raw notes in LLM_WIKI_INPUT_DIR are read-only. " +
          "Do not edit or overwrite them. Synthesize findings into wiki pages " +
          "under LLM_WIKI_OUTPUT_DIR/wiki/ and use goulven_edit or the host edit tool there.",
      };
    }
  });

  // ── Session start ────────────────────────────────────────
  // The wiki extension is read-only at startup. We do NOT auto-scan
  // or rebuild the index here — those happen only
  // when the user explicitly runs goulven_scan / goulven_process. This
  // keeps pi startup fast even when the wiki input/output dirs live on
  // a slow filesystem (e.g. rclone-mounted cloud storage).
  pi.on("session_start", async (_event, ctx) => {
    if (!config) return; // dormant — silent, no error status

    // Ensure the wiki's "soul" file exists (goals/scope) — nashsu idea.
    // This is a cheap, idempotent local write, safe to run at startup.
    try {
      ensurePurposeFile(config.outputDir);
    } catch { /* non-fatal */ }
  });

  // ── Before agent start: inject context ──────────────────
  pi.on("before_agent_start", async (event, ctx) => {
    if (!config) return;

    try {
      const prompt = event.prompt || "";
      let contextInjection = "";

      // Inject purpose.md as directional context (nashsu idea) — only once it
      // has been filled in beyond the skeleton, to avoid noise.
      const purpose = readPurpose(config.outputDir);
      if (purpose && !purpose.includes("_What should this wiki help you with?")) {
        contextInjection += "\n\n## 🎯 Wiki Purpose (directional context)\n\n" + purpose.trim() + "\n";
      }

      if (contextInjection) {
        return { systemPrompt: (event.systemPrompt || "") + contextInjection };
      }
    } catch {
      // silent fail — don't break the agent
    }
  });

  // ── Tool: goulven_scan ──────────────────────────────────
  pi.registerTool({
    name: "goulven_scan",
    label: "Scan Notes",
    description:
      "Scan the input folder (LLM_WIKI_INPUT_DIR) for new or changed markdown notes. " +
      "Classifies each as work/personal based on tags or folder. " +
      "Returns counts of new and changed files.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      if (!config) {
        return { content: [{ type: "text", text: NOT_CONFIGURED_MSG }], details: {} };
      }

      const { newFiles, changedFiles } = scanInputDir(config.inputDir, state);

      for (const f of newFiles) state.files[f.path] = f;
      for (const f of changedFiles) state.files[f.path] = f;

      const allFiles = Object.values(state.files);
      state.lastScan = new Date().toISOString();

      state.searchIndex = buildSearchIndex(config.inputDir, config.outputDir);

      saveState(config.outputDir, state);
      rebuildIndex(config.outputDir, state);
      appendLog(config.outputDir, `Scan: ${newFiles.length} new, ${changedFiles.length} changed, ${Object.keys(state.searchIndex.tokens).length} index tokens`);

      const workFiles = allFiles.filter(f => f.classified === "work").length;
      const personalFiles = allFiles.filter(f => f.classified === "personal").length;
      const unclassified = allFiles.filter(f => f.classified === "unclassified").length;

      let text = "## Scan Results\n\n";
      text += `| Category | Count |\n|----------|-------|\n`;
      text += `| Total files | ${allFiles.length} |\n`;
      text += `| 🆕 New | ${newFiles.length} |\n`;
      text += `| 📝 Changed | ${changedFiles.length} |\n`;
      text += `| 💼 Work | ${workFiles} |\n`;
      text += `| 🏠 Personal | ${personalFiles} |\n`;
      text += `| ❓ Unclassified | ${unclassified} |\n`;

      if (newFiles.length > 0) {
        text += `\n### 🆕 New files to process\n\n`;
        for (const f of newFiles) {
          text += `- \`${f.path}\` — ${f.classified}${f.tags.length > 0 ? ` [${f.tags.join(", ")}]` : ""}\n`;
        }
        text += `\nCall **goulven_process** to generate wiki pages for these files.\n`;
      }

      text += `\n### 🔍 Search index\n\n`;
      text += `Built at \`${state.searchIndex.built}\` — ${Object.keys(state.searchIndex.tokens).length} unique tokens across ${Object.keys(state.searchIndex.fileMtimes).length} files. `;
      text += `Prompt-time search is now I/O-free.\n`;

      return {
        content: [{ type: "text", text }],
        details: { newFiles: newFiles.length, changedFiles: changedFiles.length },
      };
    },
  });

  // ── Tool: goulven_process ───────────────────────────────
  pi.registerTool({
    name: "goulven_process",
    label: "Process Notes",
    description:
      "Process unscanned or changed notes into wiki pages. " +
      "Generates source summary pages and entity/concept pages based on frontmatter. " +
      "Call goulven_scan first to discover new files, then call this to generate wiki pages.",
    parameters: Type.Object({
      file: Type.Optional(Type.String({
        description: "Optional: process a specific file (relative path from input dir). If omitted, processes all unprocessed files.",
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!config) {
        return { content: [{ type: "text", text: NOT_CONFIGURED_MSG }], details: {} };
      }

      const toProcess = params.file
        ? [state.files[params.file]].filter(Boolean)
        : Object.values(state.files).filter(f => !f.processed);

      if (toProcess.length === 0) {
        return {
          content: [{ type: "text", text: "No unprocessed files found. All notes are up to date." }],
          details: {},
        };
      }

      let text = `## Processing ${toProcess.length} file(s)\n\n`;
      const allPages: string[] = [];

      for (const file of toProcess) {
        try {
          const pages = generateWikiPages(config.inputDir, config.outputDir, file, state);
          file.processed = true;
          file.wikiPages = pages;
          state.files[file.path] = file;
          allPages.push(...pages);

          text += `- ✅ **${file.path}** → ${pages.length} page(s): ${pages.map(p => `\`${p}\``).join(", ")}\n`;
        } catch (err: any) {
          text += `- ❌ **${file.path}** — Error: ${err.message}\n`;
        }
      }

      saveState(config.outputDir, state);
      rebuildIndex(config.outputDir, state);

      // Rebuild the search index — the wiki dir now has new content.
      // Same I/O cost as before, but only at this explicit user action.
      state.searchIndex = buildSearchIndex(config.inputDir, config.outputDir);
      saveState(config.outputDir, state);

      appendLog(config.outputDir, `Process: ${toProcess.length} files → ${allPages.length} wiki pages, index rebuilt (${Object.keys(state.searchIndex.tokens).length} tokens)`);

      text += `\n### Generated pages (skeletons)\n\n`;
      for (const p of allPages) text += `- \`${p}\`\n`;

      text += `\n---\n## ⚡ Two-Step Ingest (do this now for quality)\n\n`;
      text += `First read \`purpose.md\` in the output dir — it states the wiki's goals and scope.\n\n`;
      text += `**Step 1 — Analyze.** For each source page in \`wiki/*/sources/\`, read the raw content, then think through:\n`;
      text += `- Key entities, concepts, and arguments\n`;
      text += `- Connections to existing pages (use \`goulven_search\` to find them)\n`;
      text += `- **Contradictions** with existing knowledge — flag them explicitly\n`;
      text += `- Which entity/concept pages to create or update\n\n`;
      text += `**Step 2 — Generate.** Then \`edit\` each page:\n`;
      text += `- Source pages: clear summary, list entities/concepts, note contradictions\n`;
      text += `- Entity/concept pages: describe, then link related pages with \`[[wikilinks]]\`\n`;
      text += `- Every claim cites its source page\n\n`;
      text += `**Contradiction format:**\n`;
      text += `> ⚠️ **Contradiction:** Source A claims X, but Source B claims Y. See [[page-a]] and [[page-b]].\n`;

      return {
        content: [{ type: "text", text }],
        details: { processed: toProcess.length, pages: allPages },
      };
    },
  });

  // ── Tool: goulven_search ────────────────────────────────
  pi.registerTool({
    name: "goulven_search",
    label: "Search Wiki",
    description:
      "Unified search across both wiki pages (generated knowledge) and raw notes (original markdown). " +
      "Returns ranked results with titles, snippets, source type, and tags. " +
      "Use this before answering questions to find relevant context.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query — key terms to find" }),
      max_results: Type.Optional(Type.Number({ description: "Max results (default 10)", default: 10 })),
      source: Type.Optional(StringEnum(["all", "wiki", "raw"] as const, {
        description: "Filter by source type (default: all)",
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!config) {
        return { content: [{ type: "text", text: NOT_CONFIGURED_MSG }], details: {} };
      }

      if (!state.searchIndex) {
        return {
          content: [{
            type: "text",
            text:
              `🔍 No search index yet.\n\n` +
              `The wiki builds its search index only when you explicitly call **goulven_scan** (or **goulven_process**). ` +
              `This keeps the prompt path I/O-free — search is then a fast O(1) lookup.\n\n` +
              `Run \`goulven_scan\` first, then re-run this search.`,
          }],
          details: { results: [] },
        };
      }

      const maxResults = params.max_results ?? 10;
      let results = unifiedSearch(params.query, config.inputDir, config.outputDir, state, maxResults * 2);

      if (params.source && params.source !== "all") {
        results = results.filter(r => r.source === params.source);
      }

      results = results.slice(0, maxResults);

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No results found for "${params.query}".` }],
          details: { results: [] },
        };
      }

      let text = `## Search: "${params.query}" — ${results.length} result(s) `;
      text += `(index from ${state.searchIndex.built})\n\n`;
      text += `| # | Title | Source | Tags | Score |\n`;
      text += `|---|-------|--------|------|-------|\n`;

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const sourceIcon = r.source === "wiki" ? "📖" : "📄";
        const staleMark = r.stale ? " ⚠️" : "";
        text += `| ${i + 1} | ${r.title}${staleMark} | ${sourceIcon} ${r.source} | ${r.tags.join(", ") || "—"} | ${r.score} |\n`;
      }

      text += `\n### Top Results\n\n`;
      for (const r of results.slice(0, 5)) {
        text += `#### ${r.title}${r.stale ? " ⚠️ (file changed since last scan)" : ""}\n`;
        text += `- **Path:** \`${r.path}\`\n`;
        text += `- **Source:** ${r.source} | **Tags:** ${r.tags.join(", ") || "none"}\n`;
        text += `- **Snippet:**\n  > ${r.snippet.replace(/\n/g, "\n  > ")}\n\n`;
      }

      text += `\nUse **goulven_read** with a result's \`Path\` to view the full page content.\n`;

      return {
        content: [{ type: "text", text }],
        details: { results },
      };
    },
  });

  // ── Tool: goulven_read ─────────────────────────────────
  // Resolves a path returned by goulven_search (relative to the wiki or
  // raw-notes root) and returns the file's full content. Avoids making the
  // LLM reconstruct absolute paths from env vars it can't see.
  pi.registerTool({
    name: "goulven_read",
    label: "Read Wiki Page",
    description:
      "Read a wiki page or raw note by its path. " +
      "Accepts the relative path returned by goulven_search " +
      "(e.g. 'wiki/personal/entities/sophie-boudet-dalbin.md' or " +
      "'2026-06-05 104406.md'), or an absolute path. " +
      "Prefer this over the host's read tool when working with goulven_search results.",
    parameters: Type.Object({
      path: Type.String({
        description:
          "Path to the file. Relative paths starting with 'wiki/' resolve " +
          "under the wiki output dir; any other relative path resolves under " +
          "the raw notes input dir. Absolute paths are read as-is.",
      }),
      max_bytes: Type.Optional(Type.Number({
        description: "Optional cap on bytes returned (default: 200000 ≈ 200KB).",
        default: 200000,
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!config) {
        return { content: [{ type: "text", text: NOT_CONFIGURED_MSG }], details: {} };
      }

      const inputPath = params.path.trim();

      // Resolve to an absolute path. Try in order:
      //   1) absolute path as-is
      //   2) path starting with "wiki/" or "wiki"  → ${outputDir}/${path}
      //      (search results for wiki pages always start with "wiki/")
      //   3) anything else                          → ${inputDir}/${path}
      //      (search results for raw notes look like "2026-06-05 104406.md")
      let absPath: string | null = null;
      let resolvedAs: "absolute" | "wiki" | "raw" = "absolute";

      if (existsSync(inputPath)) {
        absPath = inputPath;
        resolvedAs = "absolute";
      } else {
        const looksLikeWikiResult = inputPath === "wiki" || inputPath.startsWith("wiki/") || inputPath.startsWith("wiki\\");
        if (looksLikeWikiResult) {
          const wikiCandidate = join(config.outputDir, inputPath);
          if (existsSync(wikiCandidate)) {
            absPath = wikiCandidate;
            resolvedAs = "wiki";
          }
        }
        if (!absPath) {
          const rawCandidate = join(config.inputDir, inputPath);
          if (existsSync(rawCandidate)) {
            absPath = rawCandidate;
            resolvedAs = "raw";
          }
        }
      }

      if (!absPath) {
        return {
          content: [{
            type: "text",
            text:
              `❌ File not found: \`${inputPath}\`\n\n` +
              `Tried:\n` +
              `  - as absolute path\n` +
              `  - in wiki output dir: \`${config.outputDir}/${inputPath}\`\n` +
              `  - in raw notes input dir: \`${config.inputDir}/${inputPath}\`\n\n` +
              `Tip: paths from goulven_search are relative; pass them as-is to goulven_read.`,
          }],
          details: { path: inputPath, outputDir: config.outputDir, inputDir: config.inputDir },
        };
      }

      // Refuse to escape the configured roots unless the user passed an absolute path.
      const normalized = absPath.replace(/\\/g, "/");
      const inOutput = normalized.startsWith(config.outputDir.replace(/\\/g, "/"));
      const inInput = normalized.startsWith(config.inputDir.replace(/\\/g, "/"));
      if (resolvedAs !== "absolute" && !inOutput && !inInput) {
        return {
          content: [{
            type: "text",
            text: `❌ Refusing to read outside the configured wiki roots: \`${absPath}\``,
          }],
          details: {},
        };
      }

      let content: string;
      try {
        content = readFileSync(absPath, "utf-8");
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `❌ Cannot read \`${absPath}\`: ${err.message}` }],
          details: {},
        };
      }

      const cap = params.max_bytes ?? 200000;
      const truncated = content.length > cap;
      const body = truncated ? content.substring(0, cap) : content;

      const sourceLabel = resolvedAs === "wiki" ? "wiki page" : resolvedAs === "raw" ? "raw note" : "file";
      let text = `## ${sourceLabel}: \`${inputPath}\`\n\n`;
      text += `- **Resolved to:** \`${absPath}\`\n`;
      text += `- **Size:** ${content.length} bytes${truncated ? ` (truncated to ${cap})` : ""}\n\n`;
      text += `---\n\n`;
      text += body;
      if (truncated) {
        text += `\n\n…[truncated, ${content.length - cap} bytes remaining]`;
      }

      return {
        content: [{ type: "text", text }],
        details: { path: absPath, source: resolvedAs, size: content.length, truncated },
      };
    },
  });

  // ── Tool: goulven_edit ─────────────────────────────────
  // Apply precise text replacements to an existing wiki page.
  // Refuses to create new files; refreshes frontmatter `updated` field.
  pi.registerTool({
    name: "goulven_edit",
    label: "Edit Wiki Page",
    description:
      "Apply precise text replacements to an existing wiki page in the configured output directory. " +
      "The path must be under the wiki tree (e.g. `wiki/work/entities/alice.md`). " +
      "The file must already exist; use goulven_write to create new pages. " +
      "Each edit replaces the first exact occurrence of oldText with newText. " +
      "Frontmatter `updated` is refreshed automatically and the search index is rebuilt.",
    parameters: Type.Object({
      path: Type.String({
        description:
          "Relative wiki page path, e.g. `wiki/work/entities/alice.md`. " +
          "Must be exactly 4 segments: wiki/{work,personal}/{sources,entities,concepts,syntheses,analyses}/{filename}.md.",
      }),
      edits: Type.Array(
        Type.Object({
          oldText: Type.String({ description: "Exact text to replace." }),
          newText: Type.String({ description: "Replacement text." }),
        }),
        { description: "One or more exact-text replacements to apply." }
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!config) {
        return { content: [{ type: "text", text: NOT_CONFIGURED_MSG }], details: {} };
      }

      const result = editWikiPage(
        config.inputDir,
        config.outputDir,
        state,
        params.path,
        params.edits as WikiEdit[]
      );

      if (result.success) {
        saveState(config.outputDir, state);
      }

      return {
        content: [{ type: "text", text: result.message }],
        details: { success: result.success, path: result.relPath, absPath: result.absPath, editCount: result.editCount },
      };
    },
  });

  // ── Tool: goulven_write ─────────────────────────────────
  // Create a new wiki page inside the allowed wiki tree only.
  // Refuses to overwrite existing files (agent must use an edit tool).
  // Auto-creates parent directories and rebuilds the search index.
  pi.registerTool({
    name: "goulven_write",
    label: "Write Wiki Page",
    description:
      "Create a new wiki page in the configured output directory. " +
      "The path must be under the wiki tree (e.g. `wiki/work/entities/alice.md`). " +
      "Existing files cannot be overwritten; use an edit tool for updates. " +
      "Frontmatter is injected/updated automatically. Search index is rebuilt.",
    parameters: Type.Object({
      path: Type.String({
        description:
          "Relative wiki page path, e.g. `wiki/work/entities/alice.md`. " +
          "Must be exactly 4 segments: wiki/{work,personal}/{sources,entities,concepts,syntheses,analyses}/{filename}.md.",
      }),
      content: Type.String({
        description: "Markdown content for the new wiki page.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!config) {
        return { content: [{ type: "text", text: NOT_CONFIGURED_MSG }], details: {} };
      }

      const result = writeWikiPage(
        config.inputDir,
        config.outputDir,
        state,
        params.path,
        params.content
      );

      if (result.success) {
        saveState(config.outputDir, state);
      }

      return {
        content: [{ type: "text", text: result.message }],
        details: { success: result.success, path: result.relPath, absPath: result.absPath },
      };
    },
  });

  // ── Tool: goulven_status ────────────────────────────────
  pi.registerTool({
    name: "goulven_status",
    label: "Wiki Status",
    description:
      "Show Goulven Wiki statistics: file counts, classification breakdown, " +
      "wiki page counts, and configuration info.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      if (!config) {
        return { content: [{ type: "text", text: NOT_CONFIGURED_MSG }], details: {} };
      }

      const allFiles = Object.values(state.files);
      const workFiles = allFiles.filter(f => f.classified === "work");
      const personalFiles = allFiles.filter(f => f.classified === "personal");
      const unclassified = allFiles.filter(f => f.classified === "unclassified");
      const processed = allFiles.filter(f => f.processed);

      // Count wiki pages
      let wikiPageCount = 0;
      const wikiDir = join(config.outputDir, "wiki");
      if (existsSync(wikiDir)) {
        const countFiles = (dir: string): number => {
          let count = 0;
          try {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              if (entry.name.startsWith(".")) continue;
              const full = join(dir, entry.name);
              if (entry.isDirectory()) count += countFiles(full);
              else if (entry.name.endsWith(".md")) count++;
            }
          } catch { /* skip */ }
          return count;
        };
        wikiPageCount = countFiles(wikiDir);
      }

      let text = "## 🧠 Goulven Wiki Status\n\n";
      text += `| Metric | Value |\n|--------|-------|\n`;
      text += `| Input dir | \`${config.inputDir}\` |\n`;
      text += `| Output dir | \`${config.outputDir}\` |\n`;
      text += `| Total notes | ${allFiles.length} |\n`;
      text += `| 💼 Work notes | ${workFiles.length} |\n`;
      text += `| 🏠 Personal notes | ${personalFiles.length} |\n`;
      text += `| ❓ Unclassified | ${unclassified.length} |\n`;
      text += `| ✅ Processed | ${processed.length} |\n`;
      text += `| 📖 Wiki pages | ${wikiPageCount} |\n`;
      text += `| Last scan | ${state.lastScan || "never"} |\n`;

      return {
        content: [{ type: "text", text }],
        details: {
          inputDir: config.inputDir,
          outputDir: config.outputDir,
          totalFiles: allFiles.length,
          workFiles: workFiles.length,
          personalFiles: personalFiles.length,
          wikiPages: wikiPageCount,
        },
      };
    },
  });
}
