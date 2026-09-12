/**
 * Token-count footer extension
 *
 * Replaces pi's default footer with one that shows the *actual* estimated
 * context-token count instead of a percentage.
 *
 * Everything else is kept as close as possible to the built-in footer:
 * cwd, git branch, session name, cumulative token/cache/cost stats, model,
 * thinking level, provider indicator and extension statuses.
 *
 * Enable/disable on the fly with /token-footer.
 */

import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";

let enabled = true;

// ── Streaming speed tracking (module-level, survives re-renders) ──
// Each text block gets its own measurement: estimated tokens (chars/4) ÷ streaming duration.
// Sliding window of last 20 blocks; resets on model change so each model is independent.
const MAX_SPEED_SAMPLES = 20;
const streamingMeasurements: { tokens: number; durationMs: number }[] = [];
const textStartTimes = new Map<number, number>(); // contentIndex → Date.now()

// Fit a (possibly ANSI-colored) string to an exact visible width: truncate
// if too wide (ANSI-aware), pad with spaces if too narrow.
function fitLine(s: string, w: number): string {
	const vw = visibleWidth(s);
	if (vw === w) return s;
	if (vw < w) return s + " ".repeat(w - vw);
	return truncateToWidth(s, w);
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

export default function (pi: ExtensionAPI) {
	// Keep a handle to the current footer TUI so we can request re-renders
	// when context usage, model or thinking level changes.
	let footerTui: { requestRender: () => void } | undefined;

	function requestFooterRender() {
		footerTui?.requestRender();
	}

	// Re-render footer when data that affects it changes.
	pi.on("message_end", requestFooterRender);
	pi.on("model_select", requestFooterRender);
	pi.on("thinking_level_select", requestFooterRender);

	// Reset speed tracking on model change so each model gets its own measurement
	pi.on("model_select", () => {
		streamingMeasurements.length = 0;
		textStartTimes.clear();
	});

	// ── Track streaming speed from text_start/text_end events ──
	pi.on("message_update", (_event) => {
		const e = _event.assistantMessageEvent;
		if (e.type === "text_start") {
			textStartTimes.set(e.contentIndex, Date.now());
		} else if (e.type === "text_end") {
			const startTs = textStartTimes.get(e.contentIndex);
			if (startTs !== undefined) {
				textStartTimes.delete(e.contentIndex);
				const durationMs = Date.now() - startTs;
				const estimatedTokens = Math.max(1, Math.round(e.content.length / 4));
				if (durationMs > 0) {
					streamingMeasurements.push({ tokens: estimatedTokens, durationMs });
					// Sliding window: keep only the last N samples
					if (streamingMeasurements.length > MAX_SPEED_SAMPLES) {
						streamingMeasurements.shift();
					}
				}
			}
		} else if (e.type === "done" || e.type === "error") {
			// Abandon any text blocks that never got their text_end
			textStartTimes.clear();
		}
	});

	function createFooterFactory(ctx: ExtensionContext) {
		return (
			tui: {
				requestRender: () => void;
			},
			theme: {
				fg: (color: string, text: string) => string;
			},
			footerData: {
				getGitBranch: () => string | null;
				getExtensionStatuses: () => ReadonlyMap<string, string>;
				getAvailableProviderCount: () => number;
				onBranchChange: (cb: () => void) => (() => void);
			},
		) => {
			footerTui = tui;
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose() {
					unsubBranch();
					if (footerTui === tui) footerTui = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					// Inset the footer by 1 space on each side so it aligns under the
					// rounded input box (box interior = width - 2).
					const inner = Math.max(2, width - 2);

					// ---- cumulative usage from all assistant messages ----
					let totalInput = 0;
					let totalOutput = 0;
					let totalCacheRead = 0;
					let totalCacheWrite = 0;
					let totalCost = 0;
					let latestCacheHitRate: number | undefined;

					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const m = entry.message as AssistantMessage;
							totalInput += m.usage.input;
							totalOutput += m.usage.output;
							totalCacheRead += m.usage.cacheRead;
							totalCacheWrite += m.usage.cacheWrite;
							totalCost += m.usage.cost.total;

							const promptTokens = m.usage.input + m.usage.cacheRead + m.usage.cacheWrite;
							latestCacheHitRate =
								promptTokens > 0 ? (m.usage.cacheRead / promptTokens) * 100 : undefined;
						}
					}

					// ---- current context usage: token count instead of % ----
					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextTokens = contextUsage?.tokens ?? null;
					const contextPercent = contextUsage?.percent ?? 0;

					// ---- cwd line with git branch and session name ----
					let pwd = formatCwdForFooter(
						ctx.sessionManager.getCwd(),
						process.env.HOME || process.env.USERPROFILE,
					);
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;

					// ---- stats line (left side) ----
					const statsParts: string[] = [];
					if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
					if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
					if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
					if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
					if (
						(totalCacheRead > 0 || totalCacheWrite > 0) &&
						latestCacheHitRate !== undefined
					) {
						statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
					}

					// ---- token speed (avg of per-text-block streaming speeds) ----
					if (streamingMeasurements.length > 0) {
						const speeds = streamingMeasurements.map(m => m.tokens / (m.durationMs / 1000));
						const avgTps = speeds.reduce((a, b) => a + b, 0) / speeds.length;
						statsParts.push(`⚡${formatTokens(Math.round(avgTps))}/s`);
					}

					const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
					if (totalCost || usingSubscription) {
						statsParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
					}

					// Context usage: actual tokens / max tokens, colored by %
					const contextDisplay =
						contextTokens === null
							? `?/${formatTokens(contextWindow)}`
							: `${formatTokens(contextTokens)}/${formatTokens(contextWindow)}`;

					let contextStr: string;
					if (contextPercent && contextPercent > 90) {
						contextStr = theme.fg("error", contextDisplay);
					} else if (contextPercent && contextPercent > 70) {
						contextStr = theme.fg("warning", contextDisplay);
					} else {
						contextStr = contextDisplay;
					}
					statsParts.push(contextStr);

					let statsLeft = statsParts.join(" ");
					let statsLeftWidth = visibleWidth(statsLeft);
					if (statsLeftWidth > inner) {
						statsLeft = truncateToWidth(statsLeft, inner, "...");
						statsLeftWidth = visibleWidth(statsLeft);
					}

					// ---- right side: model / thinking / provider ----
					const modelName = ctx.model?.id || "no-model";
					let rightSideWithoutProvider = modelName;
					if (ctx.model?.reasoning) {
						const level = pi.getThinkingLevel() || "off";
						rightSideWithoutProvider =
							level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
					}

					let rightSide = rightSideWithoutProvider;
					if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
						rightSide = `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
						if (statsLeftWidth + 2 + visibleWidth(rightSide) > inner) {
							rightSide = rightSideWithoutProvider;
						}
					}

					// ---- assemble stats line with right-aligned model ----
					let statsLine: string;
					const rightWidth = visibleWidth(rightSide);
					const totalNeeded = statsLeftWidth + 2 + rightWidth;

					if (totalNeeded <= inner) {
						const padding = " ".repeat(inner - statsLeftWidth - rightWidth);
						statsLine = statsLeft + padding + rightSide;
					} else {
						const availableForRight = inner - statsLeftWidth - 2;
						if (availableForRight > 0) {
							const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
							const truncatedWidth = visibleWidth(truncatedRight);
							const padding = " ".repeat(Math.max(0, inner - statsLeftWidth - truncatedWidth));
							statsLine = statsLeft + padding + truncatedRight;
						} else {
							statsLine = statsLeft;
						}
					}

					// ---- dim everything, but preserve the colored context part ----
					const dimStatsLeft = theme.fg("dim", statsLeft);
					const remainder = statsLine.slice(statsLeft.length);
					const dimRemainder = theme.fg("dim", remainder);

					const pwdLine = truncateToWidth(theme.fg("dim", pwd), inner, theme.fg("dim", "..."));
					const lines = [pwdLine, dimStatsLeft + dimRemainder];

					// ---- extension statuses line ----
					const extensionStatuses = footerData.getExtensionStatuses();
					if (extensionStatuses.size > 0) {
						const sortedStatuses = Array.from(extensionStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text));
						lines.push(
							truncateToWidth(sortedStatuses.join(" "), inner, theme.fg("dim", "...")),
						);
					}

					// Pad 1 space left/right so the footer sits inside the rounded input
					// box (between its │ rails).
					return lines.map((l) => ` ${fitLine(l, inner)} `);
				},
			};
		};
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!enabled || ctx.mode !== "tui") return;
		ctx.ui.setFooter(createFooterFactory(ctx));
	});

	pi.registerCommand("token-footer", {
		description: "Toggle token-count footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) {
				ctx.ui.setFooter(createFooterFactory(ctx));
				ctx.ui.notify("Token-count footer enabled", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Default footer restored", "info");
			}
		},
	});
}
