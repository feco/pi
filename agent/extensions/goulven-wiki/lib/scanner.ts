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

    if (!existing) {
      // New file
      const entry = classifyFile(inputDir, absPath, relPath, mtimeMs);
      newFiles.push(entry);
      allFiles.push(entry);
    } else if (existing.mtimeMs !== mtimeMs) {
      // Changed file
      const entry = classifyFile(inputDir, absPath, relPath, mtimeMs);
      entry.processed = false; // re-process changed files
      entry.wikiPages = [];    // reset wiki pages
      changedFiles.push(entry);
      allFiles.push(entry);
    } else {
      allFiles.push(existing);
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
 * Classify a file as work, personal, or unclassified based on:
 * 1. Frontmatter tags (tags: [work] or tags: [personal])
 * 2. Parent folder name (work/ or personal/)
 */
function classifyFile(
  inputDir: string,
  absPath: string,
  relPath: string,
  mtimeMs: number
): FileEntry {
  let tags: string[] = [];
  let classified: "work" | "personal" | "unclassified" = "unclassified";

  // Try to read frontmatter
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
  } catch {
    // can't read file, skip classification
  }

  // Check tags for work/personal
  if (tags.includes("work")) {
    classified = "work";
  } else if (tags.includes("personal")) {
    classified = "personal";
  }

  // Fallback: check parent folder name
  if (classified === "unclassified") {
    const parentDir = basename(dirname(absPath)).toLowerCase();
    if (parentDir === "work") classified = "work";
    else if (parentDir === "personal") classified = "personal";
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

