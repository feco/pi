import { existsSync, realpathSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";

export const ALLOWED_CLASSIFICATIONS = ["work", "personal"] as const;
export const ALLOWED_PAGE_TYPES = ["sources", "entities", "concepts", "syntheses", "analyses"] as const;

export type Classification = (typeof ALLOWED_CLASSIFICATIONS)[number];
export type PageType = (typeof ALLOWED_PAGE_TYPES)[number];

export interface ValidatedWikiPath {
  absPath: string;
  relPath: string;
  classification: Classification;
  pageType: PageType;
}

/**
 * Validate a requested wiki page path.
 *
 * Rules:
 * - Must be relative and start with "wiki/".
 * - No ".." segments.
 * - Must end with ".md".
 * - Must have exactly 4 segments: wiki/{work,personal}/{type}/{filename}.md.
 * - Classification and page type must be in the allow lists.
 * - Resolved absolute path must stay inside ${outputDir}/wiki/.
 */
export function validateWikiPath(
  outputDir: string,
  requestedPath: string
): ({ ok: true } & ValidatedWikiPath) | { ok: false; error: string } {
  const trimmed = requestedPath.trim();

  if (!trimmed) {
    return { ok: false, error: "Path is required." };
  }

  if (trimmed.startsWith("/") || trimmed.startsWith("\\")) {
    return { ok: false, error: "Path must be relative (e.g. `wiki/work/entities/alice.md`)." };
  }

  const normalizedRequested = normalize(trimmed).replace(/\\/g, "/");

  if (normalizedRequested.includes("..")) {
    return { ok: false, error: "Path cannot contain parent-directory segments (`..`)." };
  }

  if (!normalizedRequested.startsWith("wiki/")) {
    return {
      ok: false,
      error:
        "Wiki page paths must start with `wiki/` (e.g. `wiki/work/entities/alice.md`). " +
        "Top-level files like `index.md`, `log.md`, and `.goulven-state.json` cannot be written by this tool.",
    };
  }

  if (!normalizedRequested.endsWith(".md")) {
    return { ok: false, error: "Only Markdown files (`.md`) can be written as wiki pages." };
  }

  const withoutPrefix = normalizedRequested.slice("wiki/".length);
  const parts = withoutPrefix.split("/").filter(Boolean);

  if (parts.length !== 3) {
    return {
      ok: false,
      error:
        "Wiki page path must have exactly 4 segments: `wiki/{work,personal}/{sources,entities,concepts,syntheses,analyses}/{filename}.md`. " +
        `Received ${parts.length + 1} segments.`,
    };
  }

  const [classification, pageType, fileName] = parts;

  if (!ALLOWED_CLASSIFICATIONS.includes(classification as Classification)) {
    return {
      ok: false,
      error: `Invalid classification \`${classification}\`. Must be one of: ${ALLOWED_CLASSIFICATIONS.join(", ")}.`,
    };
  }

  if (!ALLOWED_PAGE_TYPES.includes(pageType as PageType)) {
    return {
      ok: false,
      error: `Invalid page type \`${pageType}\`. Must be one of: ${ALLOWED_PAGE_TYPES.join(", ")}.`,
    };
  }

  if (!fileName || fileName === ".md") {
    return { ok: false, error: "A non-empty filename is required." };
  }

  // Resolve to absolute path and verify it stays inside outputDir/wiki.
  const absPath = resolve(join(outputDir, normalizedRequested));
  const wikiRoot = resolve(join(outputDir, "wiki"));
  const normalizedAbs = normalize(absPath).replace(/\\/g, "/");
  const normalizedWikiRoot = normalize(wikiRoot).replace(/\\/g, "/");

  if (!normalizedAbs.startsWith(normalizedWikiRoot + "/")) {
    return {
      ok: false,
      error: `Resolved path escapes the wiki root: \`${normalizedAbs}\`.`,
    };
  }

  // Harden against symlink escapes: verify the real filesystem path is still
  // inside the real wiki root. The logical check above catches ".." tricks;
  // this one catches symlinks inside the wiki tree pointing elsewhere.
  const realCheck = isWithinRealWikiRoot(normalizedWikiRoot, normalizedAbs);
  if (!realCheck.ok) {
    return { ok: false, error: realCheck.error };
  }

  return {
    ok: true,
    absPath,
    relPath: normalizedRequested,
    classification: classification as Classification,
    pageType: pageType as PageType,
  };
}

function isWithinRealWikiRoot(
  normalizedWikiRoot: string,
  normalizedAbs: string
): { ok: true } | { ok: false; error: string } {
  // Resolve the real path of the target. If it does not exist yet, walk up to
  // the deepest existing ancestor and reconstruct the real path from there.
  let realTarget: string;
  try {
    realTarget = normalize(realpathSync(normalizedAbs)).replace(/\\/g, "/");
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      return { ok: false, error: `Cannot resolve target path: ${err.message}` };
    }

    let current = normalizedAbs;
    const missing: string[] = [];
    while (true) {
      const parent = dirname(current);
      const base = current.slice(parent.length + 1);
      missing.unshift(base);
      try {
        const realParent = normalize(realpathSync(parent)).replace(/\\/g, "/");
        realTarget = normalize(join(realParent, ...missing)).replace(/\\/g, "/");
        break;
      } catch (e2: any) {
        if (e2.code !== "ENOENT") {
          return { ok: false, error: `Cannot resolve target path: ${e2.message}` };
        }
        if (parent === current) {
          return { ok: false, error: "Cannot resolve target path: no existing ancestor found." };
        }
        current = parent;
      }
    }
  }

  // Resolve the real wiki root. If it does not exist yet, realpath its parent
  // and append "wiki" so creation of the first page still lands in the right place.
  let realWikiRoot: string;
  try {
    realWikiRoot = normalize(realpathSync(normalizedWikiRoot)).replace(/\\/g, "/");
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      return { ok: false, error: `Cannot resolve wiki root: ${err.message}` };
    }
    try {
      realWikiRoot = normalize(join(realpathSync(dirname(normalizedWikiRoot)), "wiki")).replace(/\\/g, "/");
    } catch (e2: any) {
      return { ok: false, error: `Cannot resolve wiki root: ${e2.message}` };
    }
  }

  if (realTarget === realWikiRoot) {
    return { ok: false, error: "Cannot write to the wiki root directory itself." };
  }
  if (!realTarget.startsWith(realWikiRoot + "/")) {
    return {
      ok: false,
      error: `Resolved real path escapes the wiki root: \`${realTarget}\` is outside \`${realWikiRoot}\`.`,
    };
  }

  return { ok: true };
}
