import type { GoulvenState, SearchIndex, IndexEntry } from "./config.js";
import { searchWithIndex } from "./indexer.js";

export interface SearchResult {
  path: string;         // relative to outputDir (wiki) or inputDir (raw)
  title: string;
  snippet: string;      // relevant excerpt
  source: "wiki" | "raw";
  tags: string[];
  score: number;
  stale?: boolean;      // true if file mtime changed since the index was built
}

/**
 * Backwards-compatible entry point used by goulven_search and
 * before_agent_start. Behavior:
 *
 *   - If `state.searchIndex` is present, use it. No filesystem I/O happens.
 *   - If not, return an empty result list. The caller should show a friendly
 *     "run goulven_scan first" message instead of doing a full re-scan
 *     (which would re-introduce the slow-prompt-path bug we just fixed).
 *
 * The legacy disk-walking search is no longer exposed. It was the source of
 * the 18-second rclone-stall on every user prompt. The replacement is
 * `searchWithIndex` in lib/indexer.ts, fed by `buildSearchIndex` during an
 * explicit goulven_scan / goulven_process.
 */
export function unifiedSearch(
  query: string,
  _inputDir: string,
  _outputDir: string,
  state: GoulvenState,
  maxResults: number = 10,
): SearchResult[] {
  if (!state.searchIndex) return [];

  // Build a mtime map from state.files for staleness warnings.
  const stateMtimes: Record<string, number> = {};
  for (const [relPath, entry] of Object.entries(state.files)) {
    stateMtimes[relPath] = entry.mtimeMs;
  }

  const rawResults = searchWithIndex(
    query,
    state.searchIndex,
    maxResults,
    stateMtimes,
  );

  // Enrich raw results with tags (raw files get tags from state.files; wiki
  // files would need to be re-read for frontmatter, which we want to avoid
  // at prompt time — leave tags empty for wiki hits, that's fine for the
  // before_agent_start rendering and the tool result table).
  return rawResults.map(r => {
    const tags = r.source === "raw"
      ? (state.files[r.path]?.tags ?? [])
      : [];
    return { ...r, tags };
  });
}

/** True iff the wiki has been ingested at least once. Used by tools to
 *  decide whether to show the "run goulven_scan first" hint. */
export function hasIndex(state: GoulvenState): boolean {
  return !!state.searchIndex;
}

/** Human-readable description of when the index was built (or null). */
export function indexAge(state: GoulvenState): string | null {
  if (!state.searchIndex) return null;
  return state.searchIndex.built;
}
