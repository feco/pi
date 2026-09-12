import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { FileEntry, GoulvenState } from "./config.js";
import { extractBody, extractFrontmatter } from "./scanner.js";

/**
 * Generate wiki pages for a raw note.
 * Creates a source summary page and returns the paths.
 */
export function generateWikiPages(
  inputDir: string,
  outputDir: string,
  file: FileEntry,
  state: GoulvenState
): string[] {
  const absPath = join(inputDir, file.path);
  const content = readFileSync(absPath, "utf-8");
  const frontmatter = extractFrontmatter(content);
  const body = extractBody(content);
  const title = extractTitleFromFile(content, file.path);

  const classification = file.classified === "unclassified" ? "personal" : file.classified;
  const wikiDir = join(outputDir, "wiki", classification);
  const sourcesDir = join(wikiDir, "sources");

  mkdirSync(sourcesDir, { recursive: true });

  const pages: string[] = [];

  // Create source summary page
  const sourceSlug = slugify(title);
  const sourceFilename = `${sourceSlug}.md`;
  const sourcePath = join(sourcesDir, sourceFilename);
  const sourceRelPath = `wiki/${classification}/sources/${sourceFilename}`;

  // Track which entity/concept pages will be created/updated
  const linkedEntities: string[] = [];
  const linkedConcepts: string[] = [];

  // Create entity/concept pages if frontmatter specifies them
  if (frontmatter) {
    const entities = extractListField(frontmatter, "entities");
    const concepts = extractListField(frontmatter, "concepts");

    for (const entity of entities) {
      const entityDir = join(wikiDir, "entities");
      mkdirSync(entityDir, { recursive: true });
      const entityFilename = `${slugify(entity)}.md`;
      const entityPath = join(entityDir, entityFilename);
      const entityRelPath = `wiki/${classification}/entities/${entityFilename}`;

      if (!existsSync(entityPath)) {
        const entityPage = buildEntityPage(entity, classification, file, sourceRelPath);
        writeFileSync(entityPath, entityPage, "utf-8");
      } else {
        appendReference(entityPath, file, title, sourceRelPath);
      }
      pages.push(entityRelPath);
      linkedEntities.push(entityRelPath);
    }

    for (const concept of concepts) {
      const conceptDir = join(wikiDir, "concepts");
      mkdirSync(conceptDir, { recursive: true });
      const conceptFilename = `${slugify(concept)}.md`;
      const conceptPath = join(conceptDir, conceptFilename);
      const conceptRelPath = `wiki/${classification}/concepts/${conceptFilename}`;

      if (!existsSync(conceptPath)) {
        const conceptPage = buildConceptPage(concept, classification, file, sourceRelPath);
        writeFileSync(conceptPath, conceptPage, "utf-8");
      } else {
        appendReference(conceptPath, file, title, sourceRelPath);
      }
      pages.push(conceptRelPath);
      linkedConcepts.push(conceptRelPath);
    }
  }

  // Now build the source page with backlinks to generated pages
  const sourcePage = buildSourcePage(title, file, frontmatter, body, linkedEntities, linkedConcepts);
  writeFileSync(sourcePath, sourcePage, "utf-8");
  pages.push(sourceRelPath);

  return pages;
}

function buildSourcePage(
  title: string,
  file: FileEntry,
  frontmatter: string | null,
  body: string,
  linkedEntities: string[],
  linkedConcepts: string[]
): string {
  const today = new Date().toISOString().split("T")[0];
  const tags = file.tags.join(", ");
  const classification = file.classified;

  let page = "---\n";
  page += `title: "${title}"\n`;
  page += `type: source\n`;
  page += `source: "${file.path}"\n`;
  page += `created: ${today}\n`;
  page += `updated: ${today}\n`;
  page += `classification: ${classification}\n`;
  if (tags) page += `tags: [${tags}]\n`;
  if (linkedEntities.length > 0) page += `entities: [${linkedEntities.map(e => `"${e}"`).join(", ")}]\n`;
  if (linkedConcepts.length > 0) page += `concepts: [${linkedConcepts.map(c => `"${c}"`).join(", ")}]\n`;
  page += "---\n\n";
  page += `# ${title}\n\n`;
  page += `> **Raw note:** \`${file.path}\` | **Classification:** ${classification}\n`;
  page += `> **Derived from raw note in** \`LLM_WIKI_INPUT_DIR/${file.path}\`\n\n`;
  page += `## Summary\n\n`;
  page += `_This page summarizes the raw note above. The LLM will fill in the summary during processing._\n\n`;

  if (linkedEntities.length > 0) {
    page += `## Entities referenced\n\n`;
    for (const e of linkedEntities) {
      page += `- [[${e}]]\n`;
    }
    page += `\n`;
  }

  if (linkedConcepts.length > 0) {
    page += `## Concepts referenced\n\n`;
    for (const c of linkedConcepts) {
      page += `- [[${c}]]\n`;
    }
    page += `\n`;
  }

  page += `## Raw Content\n\n`;
  page += `> _The content below is the original raw note from_ \`LLM_WIKI_INPUT_DIR/${file.path}\`\n\n`;
  page += body;

  return page;
}

function buildEntityPage(
  entity: string,
  classification: string,
  source: FileEntry,
  sourcePageRelPath: string
): string {
  const today = new Date().toISOString().split("T")[0];

  let page = "---\n";
  page += `title: "${entity}"\n`;
  page += `type: entity\n`;
  page += `category: unknown\n`;
  page += `classification: ${classification}\n`;
  page += `created: ${today}\n`;
  page += `updated: ${today}\n`;
  page += `sources: ["${source.path}"]\n`;
  page += "---\n\n";
  page += `# ${entity}\n\n`;
  page += `> **Derived from:** raw note \`${source.path}\` → wiki page [[${sourcePageRelPath}]]\n\n`;
  page += `_New entity discovered from raw note \`${source.path}\`. The LLM will flesh out this page during processing._\n\n`;
  page += `## References\n\n`;
  page += `- Raw note: \`LLM_WIKI_INPUT_DIR/${source.path}\`\n`;
  page += `- Wiki source page: [[${sourcePageRelPath}]]\n`;

  return page;
}

function buildConceptPage(
  concept: string,
  classification: string,
  source: FileEntry,
  sourcePageRelPath: string
): string {
  const today = new Date().toISOString().split("T")[0];

  let page = "---\n";
  page += `title: "${concept}"\n`;
  page += `type: concept\n`;
  page += `domain: unknown\n`;
  page += `classification: ${classification}\n`;
  page += `created: ${today}\n`;
  page += `updated: ${today}\n`;
  page += `sources: ["${source.path}"]\n`;
  page += "---\n\n";
  page += `# ${concept}\n\n`;
  page += `> **Derived from:** raw note \`${source.path}\` → wiki page [[${sourcePageRelPath}]]\n\n`;
  page += `_New concept discovered from raw note \`${source.path}\`. The LLM will flesh out this page during processing._\n\n`;
  page += `## References\n\n`;
  page += `- Raw note: \`LLM_WIKI_INPUT_DIR/${source.path}\`\n`;
  page += `- Wiki source page: [[${sourcePageRelPath}]]\n`;

  return page;
}

function appendReference(
  pagePath: string,
  source: FileEntry,
  sourceTitle: string,
  sourcePageRelPath: string
): void {
  try {
    let content = readFileSync(pagePath, "utf-8");
    const refRaw = `- Raw note: \`LLM_WIKI_INPUT_DIR/${source.path}\` — ${sourceTitle}`;
    const refWiki = `- Wiki source page: [[${sourcePageRelPath}]]`;

    if (!content.includes(refRaw)) {
      if (content.includes("## References")) {
        content = content.replace("## References\n", `## References\n${refRaw}\n${refWiki}\n`);
      } else {
        content += `\n## References\n\n${refRaw}\n${refWiki}\n`;
      }
      // Also update sources in frontmatter
      content = addSourceToFrontmatter(content, source.path);
      writeFileSync(pagePath, content, "utf-8");
    }
  } catch {
    // skip
  }
}

function extractTitleFromFile(content: string, filePath: string): string {
  // Try first heading
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) return headingMatch[1].trim();

  // Try frontmatter title
  const fmMatch = content.match(/^---\n[\s\S]*?^title\s*:\s*(.+)$/m);
  if (fmMatch) return fmMatch[1].trim().replace(/^["']|["']$/g, "");

  // Fallback to filename
  return filePath.split("/").pop()?.replace(/\.md$/, "").replace(/[-_]/g, " ") ?? "Untitled";
}

function extractListField(frontmatter: string, field: string): string[] {
  const regex = new RegExp(`^${field}\\s*:\\s*\\[(.+?)\\]`, "m");
  const match = frontmatter.match(regex);
  if (match) {
    return match[1]
      .split(/[,]/)
      .map(s => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }

  // Also try YAML list format
  const listRegex = new RegExp(`^${field}\\s*:\\s*\\n((?:\\s+-\\s+.+\\n?)+)`, "m");
  const listMatch = frontmatter.match(listRegex);
  if (listMatch) {
    return listMatch[1]
      .split("\n")
      .map(line => line.replace(/^\s+-\s+/, "").trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }

  return [];
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 64);
}

/**
 * Add a source path to the frontmatter `sources` list if not already present.
 */
function addSourceToFrontmatter(content: string, sourcePath: string): string {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return content;

  const frontmatter = fmMatch[1];

  // Check if source already listed
  if (frontmatter.includes(`"${sourcePath}"`)) return content;

  // Try to append to existing sources array
  const sourcesMatch = frontmatter.match(/^sources\s*:\s*\[(.+?)\]/m);
  if (sourcesMatch) {
    const newSources = `sources: [${sourcesMatch[1]}, "${sourcePath}"]`;
    const newFm = frontmatter.replace(/^sources\s*:\s*\[.+?\]/m, newSources);
    return content.replace(fmMatch[0], `---\n${newFm}\n---`);
  }

  // No sources field — add one before the closing ---
  const newFm = frontmatter + `sources: ["${sourcePath}"]\n`;
  return content.replace(fmMatch[0], `---\n${newFm}\n---`);
}
