import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import type { FileEntry, GoulvenState } from "./config.js";

/**
 * Scan the input directory for markdown files.
 * Returns newly discovered and changed files.
 */
export function scanInputDir(
  inputDir: string,
  state: GoulvenState
): { newFiles: FileEntry[]; changedFiles: FileEntry[]; allFiles: FileEntry[] } {
  const newFiles: FileEntry[] = [];
  const changedFiles: FileEntry[] = [];
  const allFiles: FileEntry[] = [];

  const mdFiles = findMarkdownFiles(inputDir);

  for (const absPath of mdFiles) {
    const relPath = relative(inputDir, absPath);
    const stat = statSync(absPath);
    const mtimeMs = stat.mtimeMs;

    const existing = state.files[relPath];

    // Always re-classify: classification rules evolve (e.g. the jdr tree was
    // added after the wiki already existed), so tags cached in existing state
    // entries can be stale. Classification only reads file content, which the
    // indexer reads again anyway — the cost is negligible.
    const entry = classifyFile(inputDir, absPath, relPath, mtimeMs);

    if (!existing) {
      // New file
      newFiles.push(entry);
      allFiles.push(entry);
    } else if (existing.mtimeMs !== mtimeMs) {
      // Changed file
      entry.processed = false; // re-process changed files
      entry.wikiPages = [];    // reset wiki pages
      changedFiles.push(entry);
      allFiles.push(entry);
    } else {
      // Unchanged: adopt the fresh classification, keep the processed flags
      entry.processed = existing.processed;
      entry.wikiPages = existing.wikiPages;
      allFiles.push(entry);
    }
  }

  return { newFiles, changedFiles, allFiles };
}

function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    // Skip hidden files/dirs and the output dir itself
    if (entry.name.startsWith(".")) continue;

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      results.push(...findMarkdownFiles(fullPath));
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Classify a file as work, personal, jdr, or unclassified based on:
 * 1. Tags — frontmatter `tags:` and/or inline hashtags:
 *    #jdr (RPG — checked first, always wins), #elia (work), #perso (personal)
 * 2. Parent folder name (work/, personal/, or jdr/)
 */
function classifyFile(
  inputDir: string,
  absPath: string,
  relPath: string,
  mtimeMs: number
): FileEntry {
  let tags: string[] = [];
  let classified: "work" | "personal" | "jdr" | "unclassified" = "unclassified";

  // Read frontmatter tags and inline hashtags.
  try {
    const content = readFileSync(absPath, "utf-8");
    const frontmatter = extractFrontmatter(content);
    if (frontmatter) {
      const tagLine = frontmatter.match(/^tags?\s*:\s*\[(.+?)\]/m) ||
                      frontmatter.match(/^tags?\s*:\s*(.+)$/m);
      if (tagLine) {
        tags = tagLine[1]
          .split(/[,]/)
          .map(t => t.trim().replace(/^["']|["']$/g, "").toLowerCase())
          .filter(Boolean);
      }
    }
    // Inline hashtags are the user's primary tagging style (#jdr, #elia, #perso).
    // Also accept "# elia" heading style (space after the hash). Merge findings
    // into the tag list so they surface in status counts and generated
    // source-page frontmatter.
    const inlineTags = [...extractBody(content).matchAll(/(?:^|\s)#\s*(jdr|elia|perso)\b/gi)]
      .map(m => m[1].toLowerCase());
    for (const t of inlineTags) {
      if (!tags.includes(t)) tags.push(t);
    }
  } catch {
    // can't read file, skip classification
  }

  // Classification: #jdr is checked FIRST so RPG notes are never merged into
  // work/personal, even when a note carries several tags (e.g. "#perso #jdr").
  // Mapping: jdr → jdr, elia → work, perso → personal.
  if (tags.includes("jdr")) {
    classified = "jdr";
  } else if (tags.includes("work") || tags.includes("elia")) {
    classified = "work";
  } else if (tags.includes("personal") || tags.includes("perso")) {
    classified = "personal";
  }

  // Fallback: check parent folder name
  if (classified === "unclassified") {
    const parentDir = basename(dirname(absPath)).toLowerCase();
    if (parentDir === "work") classified = "work";
    else if (parentDir === "personal") classified = "personal";
    else if (parentDir === "jdr") classified = "jdr";
  }

  return {
    path: relPath,
    mtimeMs,
    tags,
    classified,
    processed: false,
    wikiPages: [],
  };
}

/**
 * Extract YAML frontmatter from markdown content.
 * Returns the frontmatter string (between --- delimiters) or null.
 */
export function extractFrontmatter(content: string): string | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : null;
}

/**
 * Extract the body content (everything after frontmatter) from markdown.
 */
export function extractBody(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}

