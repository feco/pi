/**
 * piRedesign — minimalist welcome box + rounded input bar for pi.
 *
 * Replaces the old startup-clock / welcome-minimal extension. Renders a single
 * rounded box in the header with three columns (timer reminder · skills ·
 * extensions) plus an update-check footer line, and wraps the input editor in a
 * rounded box with static gray borders (ignoring the thinking-level color).
 *
 * Requires `quietStartup: true` in settings.json to suppress the built-in
 * loaded-resources listing (this box replaces it).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { VERSION, CustomEditor, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, TUI, EditorTheme } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Theme capture
// ---------------------------------------------------------------------------
// Extensions are loaded by jiti, which can create a separate module cache
// where the global `theme` singleton is uninitialized. The header factory,
// however, receives the *real* active Theme from the framework, so we capture
// it there and reuse it in the editor factory (which only gets EditorTheme).
type Fg = (s: string) => string;
let activeTheme: {
  fg: (token: string, s: string) => string;
  bold: (s: string) => string;
} | undefined;

const grayFallback: Fg = (s) => `\x1b[38;2;80;80;80m${s}\x1b[0m`;
function gray(): Fg {
  if (activeTheme) return (s: string) => activeTheme!.fg("borderMuted", s);
  return grayFallback;
}

// ---------------------------------------------------------------------------
// Update check
// ---------------------------------------------------------------------------
async function getLatestVersion(): Promise<string | undefined> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch("https://pi.dev/api/latest-version", {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    const data = (await res.json()) as { version?: string; latest?: string };
    return data.version ?? data.latest;
  } catch {
    return undefined;
  }
}

function cmpVersion(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Skills / extensions discovery
// ---------------------------------------------------------------------------
function cleanName(n: string): string {
  return n.replace(/^skill:/, "").replace(/\.ts$/, "");
}

function getSkills(pi: ExtensionAPI): string[] {
  try {
    return pi
      .getCommands()
      .filter((c) => c.source === "skill")
      .map((c) => cleanName(c.name))
      .filter((n) => n.length > 0)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function packageDisplayName(si: { source?: string; baseDir?: string; path?: string }): string {
  // Prefer the package source id with its prefix stripped ("npm:foo" -> "foo",
  // "npm:@scope/foo" -> "foo").
  if (si.source && si.source.includes(":")) {
    const name = si.source.split(":").pop()!;
    return name.replace(/^@[^/]+\//, "");
  }
  if (si.baseDir) {
    const parts = si.baseDir.replace(/\/+$/, "").split("/");
    const last = parts[parts.length - 1] || "";
    if (last && last !== "extensions") return last.replace(/^@[^/]+\//, "");
  }
  if (si.source) return si.source.replace(/^@[^/]+\//, "");
  if (si.path) return path.basename(si.path).replace(/\.ts$/, "");
  return "package";
}

function getExtensions(pi: ExtensionAPI, agentDir: string): string[] {
  const names = new Set<string>();
  // 1) local extensions: scan ~/.pi/agent/extensions for *.ts and */index.ts
  const extDir = path.join(agentDir, "extensions");
  try {
    for (const entry of fs.readdirSync(extDir)) {
      const full = path.join(extDir, entry);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isFile() && entry.endsWith(".ts") && entry !== "piRedesign.ts") {
        names.add(entry.replace(/\.ts$/, ""));
      } else if (st.isDirectory() && fs.existsSync(path.join(full, "index.ts"))) {
        names.add(entry);
      }
    }
  } catch {
    /* ignore */
  }
  // 2) package extensions that register tools or slash commands
  const seen = new Set<string>();
  const addFrom = (si: { source?: string; baseDir?: string; path?: string; origin?: string }) => {
    if (!si || si.origin !== "package") return;
    const name = packageDisplayName(si);
    if (name && !seen.has(name)) {
      seen.add(name);
      names.add(name);
    }
  };
  try {
    for (const c of pi.getCommands()) if (c.source === "extension") addFrom(c.sourceInfo);
  } catch {
    /* ignore */
  }
  try {
    for (const t of pi.getAllTools()) addFrom(t.sourceInfo);
  } catch {
    /* ignore */
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Column rendering helpers
// ---------------------------------------------------------------------------
const ITEM_CAP = 7; // per sub-column
const REMINDER_COL = 24; // wide layout: clock + reminder text column width

/** ASCII analog clock art (left-aligned; shape relies on consistent left edge). */
const CLOCK_ART = [
  "  _______",
  " /  12   \\",
  "|    |    |",
  "|9   |   3|",
  "|     \\   |",
  "|         |",
  " \\___6___/",
];

/** Fit a (possibly ANSI-colored) string to an exact visible width: truncate
 *  if too wide (ANSI-aware), pad with spaces if too narrow. */
function fit(s: string, w: number): string {
  const vw = visibleWidth(s);
  if (vw === w) return s;
  if (vw < w) return s + " ".repeat(w - vw);
  return truncateToWidth(s, w);
}

/** Center a single (possibly ANSI-colored) line in width w. */
function center(s: string, w: number): string {
  const vw = visibleWidth(s);
  if (vw >= w) return fit(s, w);
  const left = Math.floor((w - vw) / 2);
  return " ".repeat(left) + s + " ".repeat(w - vw - left);
}

/** Center a multi-line block by giving every line the same left padding
 *  (preserves the art's relative shape, unlike per-line centering). */
function centerBlock(lines: string[], w: number, color?: (s: string) => string): string[] {
  const colored = color ? lines.map((l) => color(l)) : lines.slice();
  const artW = Math.max(...colored.map((l) => visibleWidth(l)));
  const left = Math.max(0, Math.floor((w - artW) / 2));
  return colored.map((l) => {
    const r = Math.max(0, w - left - visibleWidth(l));
    return " ".repeat(left) + l + " ".repeat(r);
  });
}

/** Sub-column visible widths that sum exactly to sectionW. */
function subColWidths(subCols: number, sectionW: number): number[] {
  const base = Math.floor(sectionW / subCols);
  const widths: number[] = [];
  for (let c = 0; c < subCols; c++) {
    widths.push(c === subCols - 1 ? sectionW - base * (subCols - 1) : base);
  }
  return widths;
}

/** Render a section (heading + items) into `subCols` side-by-side sub-columns,
 *  producing lines each exactly `sectionW` visible wide. */
function renderSection(heading: string, items: string[], subCols: number, sectionW: number): string[] {
  const T = activeTheme!;
  const headingColor = (s: string) => T.fg("mdHeading", s);
  const bulletColor = (s: string) => T.fg("text", s);
  const dim = (s: string) => T.fg("dim", s);
  const muted = (s: string) => T.fg("muted", s);
  const widths = subColWidths(subCols, sectionW);
  const totalCap = ITEM_CAP * subCols;

  const out: string[] = [fit(headingColor(heading), sectionW)];
  if (items.length === 0) {
    let row = fit(dim("— none —"), widths[0]);
    for (let c = 1; c < subCols; c++) row += " ".repeat(widths[c]);
    out.push(fit(row, sectionW));
    return out;
  }

  const shown = items.slice(0, totalCap);
  const overflow = items.length - shown.length;
  const perCol = Math.ceil(shown.length / subCols);
  const colItems: string[][] = [];
  for (let c = 0; c < subCols; c++) colItems.push(shown.slice(c * perCol, (c + 1) * perCol));

  const maxRows = Math.max(...colItems.map((c) => c.length));
  const moreRow = overflow > 0 ? colItems[0].length : -1;
  const totalRows = Math.max(maxRows, moreRow + 1);
  for (let r = 0; r < totalRows; r++) {
    let row = "";
    for (let c = 0; c < subCols; c++) {
      let cell = "";
      if (c === 0 && r === moreRow) {
        cell = muted(`+${overflow} more`);
      } else {
        const it = colItems[c][r];
        if (it !== undefined) cell = bulletColor("• ") + muted(it);
      }
      row += fit(cell, widths[c]);
    }
    out.push(fit(row, sectionW));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Welcome header component
// ---------------------------------------------------------------------------
interface WelcomeState {
  version: string;
  updateStatus: string; // "…" | "✓ up to date" | "↑ vX available" | "— check skipped"
  skills: string[];
  extensions: string[];
}

class WelcomeHeader implements Component {
  private tui: TUI;
  private state: WelcomeState;

  constructor(tui: TUI, state: WelcomeState) {
    this.tui = tui;
    this.state = state;
  }

  invalidate(): void {
    /* static content; re-render driven by state changes */
  }

  render(width: number): string[] {
    const g = gray();
    const T = activeTheme!;
    const innerWidth = Math.max(8, width - 2);

    const reminderText = "Did you set a timer?";
    const reminderLine = `${T.fg("warning", "⚠")} ${T.fg("accent", T.bold(reminderText))}`;

    // Update footer line.
    const updateLine = `pi v${this.state.version} · ${this.state.updateStatus}`;
    const updateColor = (s: string) => {
      if (this.state.updateStatus.startsWith("✓")) return T.fg("success", s);
      if (this.state.updateStatus.startsWith("↑")) return T.fg("warning", s);
      if (this.state.updateStatus.startsWith("—")) return T.fg("dim", s);
      return T.fg("muted", s);
    };

    const contentRows =
      innerWidth < 58
        ? this.renderNarrow(innerWidth, reminderLine)
        : this.renderWide(innerWidth, reminderLine);

    // Assemble the box: top border, content rows, divider, update line, bottom.
    const divider = "─".repeat(innerWidth);
    const upPadded = fit(updateColor(updateLine), innerWidth);
    const out: string[] = [];
    out.push(g("╭") + g(divider) + g("╮"));
    for (const row of contentRows) out.push(g("│") + row + g("│"));
    out.push(g("│") + g(divider) + g("│"));
    out.push(g("│") + upPadded + g("│"));
    out.push(g("╰") + g(divider) + g("╯"));
    return out;
  }

  /** Wide layout: clock+reminder column | skills | extensions, with skills and
   *  extensions each using 2 sub-columns when there is room. */
  private renderWide(innerWidth: number, reminderLine: string): string[] {
    const T = activeTheme!;
    const accent = (s: string) => T.fg("accent", s);
    const reminderCol = REMINDER_COL;
    const avail = innerWidth - reminderCol;
    const subCols = avail >= 70 ? 2 : 1;
    const skillsW = Math.floor(avail / 2);
    const extW = avail - skillsW;

    // Reminder block: clock (centered) + blank + reminder text (centered).
    const reminderBlock: string[] = centerBlock(CLOCK_ART, reminderCol, accent);
    reminderBlock.push(" ".repeat(reminderCol));
    reminderBlock.push(center(reminderLine, reminderCol));

    const skillLines = renderSection("Skills", this.state.skills, subCols, skillsW);
    const extLines = renderSection("Extensions", this.state.extensions, subCols, extW);

    const contentRows = Math.max(reminderBlock.length, skillLines.length, extLines.length);
    const rows: string[] = [];
    for (let i = 0; i < contentRows; i++) {
      const r = reminderBlock[i] ?? " ".repeat(reminderCol);
      const s = skillLines[i] ?? "";
      const e = extLines[i] ?? "";
      rows.push(fit(r, reminderCol) + fit(s, skillsW) + fit(e, extW));
    }
    return rows;
  }

  /** Narrow layout: clock + reminder banner on top, then skills | extensions. */
  private renderNarrow(innerWidth: number, reminderLine: string): string[] {
    const T = activeTheme!;
    const accent = (s: string) => T.fg("accent", s);
    const skillsW = Math.floor(innerWidth / 2);
    const extW = innerWidth - skillsW;
    const skillLines = renderSection("Skills", this.state.skills, 1, skillsW);
    const extLines = renderSection("Extensions", this.state.extensions, 1, extW);

    const contentRows = Math.max(skillLines.length, extLines.length);
    const rows: string[] = [];
    for (const l of centerBlock(CLOCK_ART, innerWidth, accent)) rows.push(l);
    rows.push(center(reminderLine, innerWidth));
    for (let i = 0; i < contentRows; i++) {
      const s = skillLines[i] ?? "";
      const e = extLines[i] ?? "";
      rows.push(fit(s, skillsW) + fit(e, extW));
    }
    return rows;
  }
}

// ---------------------------------------------------------------------------
// Rounded input editor
// ---------------------------------------------------------------------------
class RoundedEditor extends CustomEditor {
  render(width: number): string[] {
    const g = gray();
    const innerWidth = Math.max(4, width - 2);

    // Force a static gray border for this render, ignoring the thinking-level
    // color the framework keeps writing into `this.borderColor`.
    const saved = this.borderColor;
    (this as any).borderColor = g;
    let inner: string[];
    try {
      inner = super.render(innerWidth);
    } finally {
      (this as any).borderColor = saved;
    }

    // super.render() returns: [topBorder, ...content, bottomBorder, ...autocomplete]
    // Borders start (visibly) with '─'; content/autocomplete lines start with a
    // padding space. Find the bottom border = last non-top line starting with '─'.
    const strip = (s: string) =>
      s
        .replace(/\x1b\[[0-9;]*m/g, "")
        .replace(/\x1b[^\x07]*\x07/g, "");
    let bottomIdx = -1;
    for (let i = inner.length - 1; i >= 1; i--) {
      const st = strip(inner[i]);
      if (st.length > 0 && st[0] === "─") {
        bottomIdx = i;
        break;
      }
    }
    if (bottomIdx === -1) bottomIdx = inner.length - 1;

    const out: string[] = [];
    out.push(g("╭") + inner[0] + g("╮"));
    for (let i = 1; i < bottomIdx; i++) {
      out.push(g("│") + inner[i] + g("│"));
    }
    out.push(g("╰") + inner[bottomIdx] + g("╯"));
    // Autocomplete dropdown lines: inset by one space, no rails.
    for (let i = bottomIdx + 1; i < inner.length; i++) {
      out.push(" " + inner[i] + " ");
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------
export default function piRedesign(pi: ExtensionAPI): void {
  let dismissed = false;

  pi.on("session_start", (_event, ctx) => {
    dismissed = false;

    // pi's built-in startup version check shows an "Update Available" block in
    // the chat. This extension already surfaces the update status in the
    // welcome box, so suppress pi's own check to avoid the duplicate notice.
    // (PI_SKIP_VERSION_CHECK is read by version-check.js at check time, which
    // runs after init() — setting it here during session_start takes effect
    // before run() calls checkForNewPiVersion.)
    process.env.PI_SKIP_VERSION_CHECK = "1";

    const agentDir = getAgentDir();
    const skills = getSkills(pi);
    const extensions = getExtensions(pi, agentDir);

    const state: WelcomeState = {
      version: VERSION,
      updateStatus: "…",
      skills,
      extensions,
    };

    // Header: capture the real Theme, render the welcome box, kick off update.
    ctx.ui.setHeader((tui: TUI, theme: any) => {
      activeTheme = theme;
      if (process.env.PI_OFFLINE) {
        state.updateStatus = "— check skipped";
      } else {
        void (async () => {
          const latest = await getLatestVersion();
          if (!latest) {
            state.updateStatus = "— check skipped";
          } else if (cmpVersion(VERSION, latest) >= 0) {
            state.updateStatus = "✓ up to date";
          } else {
            state.updateStatus = `↑ v${latest.replace(/^v/, "")} available`;
          }
          tui.requestRender();
        })();
      }
      return new WelcomeHeader(tui, state);
    });

    // Editor: rounded box, static gray border.
    ctx.ui.setEditorComponent(
      (tui: TUI, theme: EditorTheme, keybindings: any) => new RoundedEditor(tui, theme, keybindings)
    );
  });

  // Dismiss the welcome box on the first user input; keep the rounded editor.
  pi.on("input", (_event, ctx) => {
    if (dismissed) return;
    dismissed = true;
    ctx.ui.setHeader(undefined as any);
  });
}