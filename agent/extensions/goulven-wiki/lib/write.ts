import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GoulvenState } from "./config.js";
import { enforceFrontmatter } from "./frontmatter.js";
import { buildSearchIndex } from "./indexer.js";
import { rebuildIndex, appendLog } from "./meta.js";
import { validateWikiPath } from "./validate.js";

export interface WriteResult {
  success: boolean;
  absPath: string;
  relPath: string;
  created: boolean;
  message: string;
  error?: string;
}

/**
 * Validate and write a wiki page.
 *
 * Security rules:
 * - The requested path must start with "wiki/" and resolve inside outputDir.
 * - No ".." segments or symlink escapes are allowed.
 * - Only .md files are allowed.
 * - The path must be exactly 4 segments deep: wiki/{work,personal}/{type}/{filename}.md.
 * - The page type must be one of the allowed values.
 * - Existing files are never overwritten; the caller must use an edit tool instead.
 *
 * Quality rules:
 * - Frontmatter is injected/updated with title, type, classification, created, updated.
 */
export function writeWikiPage(
  inputDir: string,
  outputDir: string,
  state: GoulvenState,
  requestedPath: string,
  content: string
): WriteResult {
  const validation = validateWikiPath(outputDir, requestedPath);
  if (!validation.ok) {
    return {
      success: false,
      absPath: "",
      relPath: requestedPath,
      created: false,
      message: validation.error,
      error: validation.error,
    };
  }

  const absPath = validation.absPath;
  const relPath = validation.relPath;
  const classification = validation.classification;
  const pageType = validation.pageType;

  if (existsSync(absPath)) {
    return {
      success: false,
      absPath,
      relPath,
      created: false,
      message: `❌ Refusing to overwrite existing file: \`${relPath}\`. Use the edit tool to modify existing wiki pages.`,
      error: "overwrite_not_allowed",
    };
  }

  const finalContent = enforceFrontmatter(content, relPath, classification, pageType);

  mkdirSync(join(absPath, ".."), { recursive: true });
  writeFileSync(absPath, finalContent, "utf-8");

  // Rebuild indexes so search reflects the new page immediately.
  state.searchIndex = buildSearchIndex(inputDir, outputDir);
  rebuildIndex(outputDir, state);
  appendLog(outputDir, `Write: ${relPath} (${finalContent.length} bytes)`);

  return {
    success: true,
    absPath,
    relPath,
    created: true,
    message: `✅ Created wiki page \`${relPath}\` (${finalContent.length} bytes). Search index rebuilt.`,
  };
}
