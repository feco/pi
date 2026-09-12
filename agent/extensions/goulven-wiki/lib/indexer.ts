import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import type { SearchIndex, IndexEntry } from "./config.js";

/** Cap on the per-file preview we cache in the index. Keeps the index small. */
const PREVIEW_BYTES = 1500;
const SNIPPET_CONTEXT = 80;

const FILENAME_EXACT_BONUS = 200.0;
const PHRASE_IN_TITLE_BONUS = 50.0;
const PHRASE_IN_CONTENT_PER_OCC = 20.0;
const MAX_PHRASE_OCC_COUNTED = 10;
const TITLE_TOKEN_WEIGHT = 5.0;
const CONTENT_TOKEN_WEIGHT = 1.0;

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be", "been",
  "to", "of", "in", "on", "at", "for", "with", "by", "from", "as", "it", "its",
  "this", "that", "these", "those", "i", "you", "he", "she", "we", "they", "me",
  "my", "do", "does", "did", "what", "which", "who", "how", "when", "where", "why",
  "about", "can", "will", "would", "should", "could", "have", "has", "had", "not",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u00c0-\u024f]+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

function trimQueryPunctuation(value: string): string {
  return value
    .toLowerCase()
    .replace(/^[^a-z0-9\u00c0-\u024f]+|[^a-z0-9\u00c0-\u024f]+$/g, "");
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function extractTitle(content: string, filename: string): string {
  const hMatch = content.match(/^#\s+(.+)$/m);
  if (hMatch) return hMatch[1].trim();
  const fmMatch = content.match(/^---\n[\s\S]*?^title\s*:\s*(.+)$/m);
  if (fmMatch) return fmMatch[1].trim().replace(/^["']|["']$/g, "");
  return filename.replace(/\.md$/, "").replace(/[-_]/g, " ");
}

function collectMarkdownFiles(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...collectMarkdownFiles(full));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") out.push(full);
  }
  return out;
}

/**
 * Build an inverted search index over both the raw notes (inputDir) and the
 * generated wiki (outputDir/wiki). Called from goulven_scan / goulven_process
 * only \u2014 never from a prompt-time event.
 *
 * Returns an index that, at search time, lets us answer "which files contain
 * token X" with a single dictionary lookup, then build snippets from the
 * cached preview. No filesystem reads happen at search time.
 */
export function buildSearchIndex(inputDir: string, outputDir: string): SearchIndex {
  const wikiDir = join(outputDir, "wiki");
  const sources: Array<{ dir: string; base: string; source: "raw" | "wiki" }> = [
    { dir: inputDir, base: inputDir, source: "raw" },
    { dir: wikiDir, base: outputDir, source: "wiki" },
  ];

  const tokens: SearchIndex["tokens"] = {};
  const fileMtimes: SearchIndex["fileMtimes"] = {};

  for (const { dir, base, source } of sources) {
    for (const absPath of collectMarkdownFiles(dir)) {
      let content: string;
      let stat: { mtimeMs: number };
      try {
        content = readFileSync(absPath, "utf-8");
        stat = statSync(absPath);
      } catch {
        continue;
      }

      const relPath = relative(base, absPath);
      const fileName = basename(absPath);
      const stem = basename(absPath, ".md").toLowerCase();
      const title = extractTitle(content, fileName);
      const fileTokens = tokenize(content);

      // Per-token count for this file.
      const counts: Record<string, number> = {};
      for (const tok of fileTokens) counts[tok] = (counts[tok] || 0) + 1;

      // Preview: capped slice of content, skipping frontmatter.
      const fmEnd = content.indexOf("\n---\n");
      const body = fmEnd >= 0 ? content.substring(fmEnd + 5) : content;
      const preview = body.length > PREVIEW_BYTES ? body.substring(0, PREVIEW_BYTES) : body;

      for (const tok of Object.keys(counts)) {
        if (!tokens[tok]) tokens[tok] = {};
        const entry: IndexEntry = { source, title, fileName, stem, count: counts[tok], preview };
        tokens[tok][relPath] = entry;
      }

      fileMtimes[relPath] = stat.mtimeMs;
    }
  }

  return {
    built: new Date().toISOString(),
    tokens,
    fileMtimes,
  };
}

export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
  source: "wiki" | "raw";
  score: number;
  stale?: boolean;
}

function normalizeForFuzzy(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u00c0-\u024f]/g, "");
}

function fuzzyStemMatch(stem: string, query: string): boolean {
  const s = normalizeForFuzzy(stem);
  const q = normalizeForFuzzy(query);
  if (!s || !q) return false;
  return s === q || s.includes(q) || q.includes(s);
}

/**
 * Look up search results using a pre-built index. Returns top-N results ranked
 * by a keyword-relevance score inspired by nashsu/llm_wiki:
 *
 *   - fuzzy filename match bonus
 *   - phrase in title bonus
 *   - phrase occurrence count in content (capped)
 *   - token matches in title (weighted)
 *   - token matches in content (weighted by occurrence count)
 *
 * No filesystem I/O happens — all data comes from the index.
 */
export function searchWithIndex(
  query: string,
  index: SearchIndex,
  maxResults: number,
  stateFilesMtimes?: Record<string, number>,
): SearchHit[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const queryPhrase = trimQueryPunctuation(query);
  const queryLower = query.toLowerCase();

  type Hit = {
    path: string;
    entry: IndexEntry;
    contentTokenScore: number;
    firstTerm: string;
  };
  const hits = new Map<string, Hit>();

  // Accumulate content token scores from the inverted index.
  for (const term of terms) {
    const postings = index.tokens[term] || {};
    for (const [path, entry] of Object.entries(postings)) {
      const existing = hits.get(path);
      if (!existing) {
        hits.set(path, { path, entry, contentTokenScore: entry.count, firstTerm: term });
      } else {
        existing.contentTokenScore += entry.count;
      }
    }
  }

  const ranked: Array<{ path: string; entry: IndexEntry; score: number; firstTerm: string }> = [];

  for (const hit of hits.values()) {
    const entry = hit.entry;
    const previewLower = entry.preview.toLowerCase();
    const titleLower = entry.title.toLowerCase();

    const filenameMatch = queryPhrase.length > 0 && fuzzyStemMatch(entry.stem, queryPhrase);
    const titleHasPhrase = queryPhrase.length > 0 && titleLower.includes(queryPhrase);
    const contentPhraseOcc = Math.min(
      countOccurrences(previewLower, queryPhrase),
      MAX_PHRASE_OCC_COUNTED,
    );
    const titleTokenScore = terms.filter(t => titleLower.includes(t)).length;

    const score =
      (filenameMatch ? FILENAME_EXACT_BONUS : 0) +
      (titleHasPhrase ? PHRASE_IN_TITLE_BONUS : 0) +
      contentPhraseOcc * PHRASE_IN_CONTENT_PER_OCC +
      titleTokenScore * TITLE_TOKEN_WEIGHT +
      hit.contentTokenScore * CONTENT_TOKEN_WEIGHT;

    ranked.push({ path: hit.path, entry, score, firstTerm: hit.firstTerm });
  }

  ranked.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (scoreDiff !== 0) return scoreDiff;
    return a.path.localeCompare(b.path);
  });

  return ranked.slice(0, maxResults).map(hit => {
    const previewLower = hit.entry.preview.toLowerCase();
    const anchor =
      countOccurrences(previewLower, queryPhrase) > 0
        ? queryPhrase
        : terms.find(t => previewLower.includes(t)) ?? queryLower;
    const snippet = buildSnippet(hit.entry.preview, anchor);
    const stale = stateFilesMtimes
      ? stateFilesMtimes[hit.path] !== index.fileMtimes[hit.path]
      : false;
    return {
      path: hit.path,
      title: hit.entry.title,
      snippet,
      source: hit.entry.source,
      score: hit.score,
      stale,
    };
  });
}

function buildSnippet(content: string, anchor: string): string {
  const lower = content.toLowerCase();
  const q = anchor.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx < 0) {
    return content.split("\n").find(l => l.trim())?.substring(0, SNIPPET_CONTEXT * 2) ||
      content.substring(0, SNIPPET_CONTEXT * 2);
  }

  const start = Math.max(0, idx - SNIPPET_CONTEXT);
  const end = Math.min(content.length, idx + anchor.length + SNIPPET_CONTEXT);
  let snippet = content.slice(start, end).replace(/\n+/g, " ");
  if (start > 0) snippet = "..." + snippet;
  if (end < content.length) snippet += "...";
  return snippet.trim();
}
