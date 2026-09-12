import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export interface GoulvenConfig {
  inputDir: string;
  outputDir: string;
}

export interface GoulvenState {
  version: 1;
  files: Record<string, FileEntry>;
  lastScan: string | null;
  // Optional — present after the first goulven_scan / goulven_process.
  // Built once at scan time so prompt-time search is O(1) and never touches
  // the (possibly slow) input/output filesystems.
  searchIndex?: SearchIndex;
}

/**
 * Persistent inverted index for fast keyword search.
 *
 * - `tokens`: token (lowercased) → path → { source, title, count, preview }
 *   - `preview` is a short excerpt of the file (max PREVIEW_BYTES) used to
 *     build a snippet around a match without re-reading the file.
 *   - `source` is "raw" (input dir) or "wiki" (output dir).
 *   - `title` is the first H1 / frontmatter title, cached so search results
 *     are emitted without touching the disk.
 * - `fileMtimes`: path → mtimeMs at index time. Used to detect files that
 *   changed since the last scan so we can warn about stale results.
 * - `built`: ISO timestamp of when the index was built.
 */
export interface SearchIndex {
  built: string;
  tokens: Record<string, Record<string, IndexEntry>>;
  fileMtimes: Record<string, number>;
}

export interface IndexEntry {
  source: "wiki" | "raw";
  title: string;
  fileName: string;
  stem: string; // filename without .md, lowercased
  count: number;
  preview: string; // capped at PREVIEW_BYTES
}

export interface FileEntry {
  path: string;        // relative to inputDir
  mtimeMs: number;     // last modified timestamp
  tags: string[];      // extracted tags (work, personal, etc.)
  classified: "work" | "personal" | "unclassified";
  processed: boolean;  // whether wiki pages have been generated
  wikiPages: string[]; // paths to generated wiki pages (relative to outputDir)
}

export function loadConfig(): GoulvenConfig {
  const inputDir = process.env.LLM_WIKI_INPUT_DIR;
  const outputDir = process.env.LLM_WIKI_OUTPUT_DIR;

  if (!inputDir) {
    throw new Error(
      "LLM_WIKI_INPUT_DIR environment variable is not set. " +
      "Set it to the folder where your raw markdown notes live.\n" +
      "Example: export LLM_WIKI_INPUT_DIR=~/Notes"
    );
  }

  if (!outputDir) {
    throw new Error(
      "LLM_WIKI_OUTPUT_DIR environment variable is not set. " +
      "Set it to the folder where the wiki should be generated (e.g., your Nextcloud folder).\n" +
      "Example: export LLM_WIKI_OUTPUT_DIR=~/Nextcloud/GoulvenWiki"
    );
  }

  const resolvedInput = resolve(inputDir.replace(/^~/, homedir()));
  const resolvedOutput = resolve(outputDir.replace(/^~/, homedir()));

  if (!existsSync(resolvedInput)) {
    throw new Error(
      `LLM_WIKI_INPUT_DIR does not exist: ${resolvedInput}\n` +
      "Create the folder or fix the env variable."
    );
  }

  // Create output dir if it doesn't exist
  if (!existsSync(resolvedOutput)) {
    mkdirSync(resolvedOutput, { recursive: true });
  }

  return { inputDir: resolvedInput, outputDir: resolvedOutput };
}

const STATE_FILE = ".goulven-state.json";

export function loadState(outputDir: string): GoulvenState {
  const statePath = join(outputDir, STATE_FILE);
  if (existsSync(statePath)) {
    try {
      return JSON.parse(readFileSync(statePath, "utf-8"));
    } catch {
      // corrupted state, start fresh
    }
  }
  return { version: 1, files: {}, lastScan: null };
}

export function saveState(outputDir: string, state: GoulvenState): void {
  const statePath = join(outputDir, STATE_FILE);
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
}
