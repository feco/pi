import type { Classification, PageType } from "./validate.js";

/**
 * Ensure the content has valid wiki frontmatter.
 * - Injects a frontmatter block if missing.
 * - Updates `updated` to today's date.
 * - Preserves existing `created` if present, otherwise sets it to today.
 * - Sets `classification` and `type` to match the resolved path.
 * - Derives `title` from existing frontmatter, H1, or filename.
 *
 * Uses string-based manipulation so multi-line YAML (lists, etc.) is preserved.
 */
export function enforceFrontmatter(
  content: string,
  relPath: string,
  classification: Classification,
  pageType: PageType
): string {
  const today = new Date().toISOString().split("T")[0];
  const filename = relPath.split("/").pop() ?? "untitled.md";
  const fallbackTitle = filename.replace(/\.md$/, "").replace(/[-_]/g, " ");

  const h1Match = content.match(/^#\s+(.+)$/m);
  const h1Title = h1Match ? h1Match[1].trim() : null;

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);

  let body = content;
  let rawFm = "";

  if (fmMatch) {
    rawFm = fmMatch[1];
    body = content.slice(fmMatch[0].length).replace(/^\n+/, "");
  }

  const title = extractField(rawFm, "title") || h1Title || fallbackTitle;
  const created = extractField(rawFm, "created") || today;

  rawFm = setField(rawFm, "title", title);
  rawFm = setField(rawFm, "type", singularType(pageType));
  rawFm = setField(rawFm, "classification", classification);
  rawFm = setField(rawFm, "created", created);
  rawFm = setField(rawFm, "updated", today);

  return `---\n${rawFm.trimEnd()}\n---\n\n${body}`;
}

function extractField(frontmatter: string, key: string): string | null {
  const regex = new RegExp(`^${key}\s*:\\s*["']?([^"'\n]+)["']?$`, "m");
  const match = frontmatter.match(regex);
  return match ? match[1].trim() : null;
}

function setField(frontmatter: string, key: string, value: string): string {
  const escaped = String(value).replace(/"/g, '\\"');
  const line = `${key}: "${escaped}"`;
  const regex = new RegExp(`^${key}\s*:\\s*.*$`, "m");

  if (frontmatter.trim().length === 0) {
    return line + "\n";
  }

  if (regex.test(frontmatter)) {
    return frontmatter.replace(regex, line);
  }

  return frontmatter.trimEnd() + "\n" + line + "\n";
}

function singularType(pageType: PageType): string {
  switch (pageType) {
    case "analyses":
      return "analysis";
    case "sources":
      return "source";
    case "entities":
      return "entity";
    case "concepts":
      return "concept";
    case "syntheses":
      return "synthesis";
    default:
      return pageType;
  }
}

/**
 * Update only the `updated` frontmatter field to today, preserving everything else.
 * If there is no frontmatter, falls back to a full enforceFrontmatter call.
 */
export function touchUpdatedFrontmatter(
  content: string,
  relPath: string,
  classification: Classification,
  pageType: PageType
): string {
  const today = new Date().toISOString().split("T")[0];
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);

  if (!fmMatch) {
    return enforceFrontmatter(content, relPath, classification, pageType);
  }

  let rawFm = fmMatch[1];
  rawFm = setField(rawFm, "updated", today);
  const body = content.slice(fmMatch[0].length).replace(/^\n+/, "");

  return `---\n${rawFm.trimEnd()}\n---\n\n${body}`;
}
