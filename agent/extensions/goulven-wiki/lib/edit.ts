import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { GoulvenState } from "./config.js";
import { touchUpdatedFrontmatter } from "./frontmatter.js";
import { buildSearchIndex } from "./indexer.js";
import { rebuildIndex, appendLog } from "./meta.js";
import { validateWikiPath } from "./validate.js";

export interface WikiEdit {
  oldText: string;
  newText: string;
}

export interface EditResult {
  success: boolean;
  absPath: string;
  relPath: string;
  message: string;
  editCount: number;
  error?: string;
}

/**
 * Apply precise text replacements to an existing wiki page.
 *
 * Security rules:
 * - Same path validation as writeWikiPage.
 * - Target file must already exist; this tool never creates new pages.
 * - Edits are applied sequentially, each oldText matched against the current content.
 *
 * Quality rules:
 * - Frontmatter `updated` field is refreshed to today's date automatically.
 */
export function editWikiPage(
  inputDir: string,
  outputDir: string,
  state: GoulvenState,
  requestedPath: string,
  edits: WikiEdit[]
): EditResult {
  const validation = validateWikiPath(outputDir, requestedPath);
  if (!validation.ok) {
    return {
      success: false,
      absPath: "",
      relPath: requestedPath,
      message: validation.error,
      editCount: 0,
      error: validation.error,
    };
  }

  const absPath = validation.absPath;
  const relPath = validation.relPath;

  if (!existsSync(absPath)) {
    return {
      success: false,
      absPath,
      relPath,
      message: `❌ File does not exist: \`${relPath}\`. Use goulven_write to create it first.`,
      editCount: 0,
      error: "file_not_found",
    };
  }

  if (!Array.isArray(edits) || edits.length === 0) {
    return {
      success: false,
      absPath,
      relPath,
      message: "No edits provided. Pass one or more `{ oldText, newText }` objects.",
      editCount: 0,
      error: "no_edits",
    };
  }

  let content: string;
  try {
    content = readFileSync(absPath, "utf-8");
  } catch (err: any) {
    return {
      success: false,
      absPath,
      relPath,
      message: `❌ Cannot read \`${relPath}\`: ${err.message}`,
      editCount: 0,
      error: "read_error",
    };
  }

  let applied = 0;
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const oldText = edit.oldText;
    const newText = edit.newText ?? "";

    if (!content.includes(oldText)) {
      return {
        success: false,
        absPath,
        relPath,
        message: `❌ Edit ${i + 1} failed: \`oldText\` not found in \`${relPath}\`.\n\nExpected:\n---\n${oldText}\n---`,
        editCount: applied,
        error: "oldText_not_found",
      };
    }

    content = content.replace(oldText, newText);
    applied++;
  }

  // Refresh the `updated` field without disturbing other frontmatter.
  const finalContent = touchUpdatedFrontmatter(
    content,
    relPath,
    validation.classification,
    validation.pageType
  );

  try {
    writeFileSync(absPath, finalContent, "utf-8");
  } catch (err: any) {
    return {
      success: false,
      absPath,
      relPath,
      message: `❌ Cannot write \`${relPath}\`: ${err.message}`,
      editCount: applied,
      error: "write_error",
    };
  }

  // Rebuild indexes so search reflects the edit immediately.
  state.searchIndex = buildSearchIndex(inputDir, outputDir);
  rebuildIndex(outputDir, state);
  appendLog(outputDir, `Edit: ${relPath} (${applied} replacement(s))`);

  return {
    success: true,
    absPath,
    relPath,
    message: `✅ Edited \`${relPath}\` — ${applied} replacement(s) applied. Search index rebuilt.`,
    editCount: applied,
  };
}
