import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GoulvenState } from "./config.js";

/**
 * Quality helpers inspired by nashsu/llm_wiki:
 * - purpose.md  — the wiki's "soul": goals, key questions, scope (read on every ingest/query)
 * - index.md    — auto-generated content catalog (LLM navigation entry point)
 * - log.md      — chronological operation record (parseable format)
 */

/** Create purpose.md skeleton if it doesn't exist. Never overwrites. */
export function ensurePurposeFile(outputDir: string): void {
  const purposePath = join(outputDir, "purpose.md");
  if (existsSync(purposePath)) return;
  const content =
    "# Wiki Purpose\n\n" +
    "> _This file defines the goals, key questions, and scope of this wiki._\n" +
    "> _The LLM reads it during every ingest and query for directional context._\n" +
    "> _Edit it freely — it is yours, never auto-overwritten._\n\n" +
    "## Goals\n\n" +
    "_What should this wiki help you with? (e.g., track work decisions, organize personal learning)_\n\n" +
    "## Key Questions\n\n" +
    "_What questions should this wiki be able to answer?_\n\n" +
    "## Scope\n\n" +
    "_What topics does this wiki cover? What's out of scope?_\n\n" +
    "## Evolving Thesis\n\n" +
    "_What are you currently exploring or trying to understand?_\n";
  writeFileSync(purposePath, content, "utf-8");
}

/** Read purpose.md content, or null if missing. */
export function readPurpose(outputDir: string): string | null {
  const purposePath = join(outputDir, "purpose.md");
  if (!existsSync(purposePath)) return null;
  try {
    return readFileSync(purposePath, "utf-8");
  } catch {
    return null;
  }
}

interface WikiPageMeta {
  relPath: string;
  title: string;
  type: string;
  classification: string;
}

/** Rebuild index.md — the content catalog grouped by classification and page type. */
export function rebuildIndex(outputDir: string, state: GoulvenState): void {
  const wikiDir = join(outputDir, "wiki");
  const pages = existsSync(wikiDir) ? collectWikiPages(wikiDir) : [];
  const today = new Date().toISOString().split("T")[0];

  let index = "# Wiki Index\n\n";
  index += `> Auto-generated ${today} — do not edit by hand. ${pages.length} wiki pages.\n\n`;

  const byClass: Record<string, WikiPageMeta[]> = {};
  for (const p of pages) (byClass[p.classification] ??= []).push(p);

  for (const cls of ["work", "personal"]) {
    const items = byClass[cls];
    if (!items || items.length === 0) continue;
    index += `## ${cls === "work" ? "💼" : "🏠"} ${cls}\n\n`;

    const byType: Record<string, WikiPageMeta[]> = {};
    for (const p of items) (byType[p.type] ??= []).push(p);

    for (const t of ["sources", "entities", "concepts", "syntheses", "analyses"]) {
      const typed = byType[t];
      if (!typed || typed.length === 0) continue;
      index += `### ${t}\n\n`;
      for (const p of typed.sort((a, b) => a.title.localeCompare(b.title))) {
        index += `- [[${p.relPath}]] — ${p.title}\n`;
      }
      index += "\n";
    }
  }

  const unprocessed = Object.values(state.files).filter(f => !f.processed);
  if (unprocessed.length > 0) {
    index += `## 📄 Raw notes awaiting processing\n\n`;
    for (const f of unprocessed) index += `- \`${f.path}\` — ${f.classified}\n`;
    index += "\n";
  }

  writeFileSync(join(outputDir, "index.md"), index, "utf-8");
}

/** Append a row to log.md — chronological, parseable operation record. */
export function appendLog(outputDir: string, entry: string): void {
  const logPath = join(outputDir, "log.md");
  const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);
  const line = `| ${timestamp} | ${entry.replace(/\|/g, "\\|")} |\n`;
  if (!existsSync(logPath)) {
    writeFileSync(logPath, "# Operation Log\n\n| Timestamp | Event |\n|-----------|-------|\n" + line, "utf-8");
  } else {
    writeFileSync(logPath, readFileSync(logPath, "utf-8") + line, "utf-8");
  }
}

function collectWikiPages(wikiDir: string): WikiPageMeta[] {
  const results: WikiPageMeta[] = [];
  for (const cls of ["work", "personal"]) {
    const clsDir = join(wikiDir, cls);
    if (!existsSync(clsDir)) continue;
    for (const pt of ["sources", "entities", "concepts", "syntheses", "analyses"]) {
      const ptDir = join(clsDir, pt);
      if (!existsSync(ptDir)) continue;
      try {
        for (const entry of readdirSync(ptDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
          try {
            const content = readFileSync(join(ptDir, entry.name), "utf-8");
            results.push({
              relPath: `wiki/${cls}/${pt}/${entry.name.replace(/\.md$/, "")}`,
              title: extractTitle(content, entry.name),
              type: pt,
              classification: cls,
            });
          } catch { /* skip unreadable */ }
        }
      } catch { /* skip */ }
    }
  }
  return results;
}

function extractTitle(content: string, filename: string): string {
  const hMatch = content.match(/^#\s+(.+)$/m);
  if (hMatch) return hMatch[1].trim();
  const fmMatch = content.match(/^---\n[\s\S]*?^title\s*:\s*(.+)$/m);
  if (fmMatch) return fmMatch[1].trim().replace(/^["']|["']$/g, "");
  return filename.replace(/\.md$/, "").replace(/[-_]/g, " ");
}
