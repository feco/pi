import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

interface Preset {
	excludeTools?: string[];
	excludeToolPrefixes?: string[];
}

interface PresetConfig {
	default: string;
	presets: Record<string, Preset>;
}

export default function presetExtension(pi: ExtensionAPI) {
	let config: PresetConfig | undefined;
	let active: string | undefined;

	function loadConfig(): PresetConfig {
		const configPath = join(getAgentDir(), "presets.json");
		if (!existsSync(configPath)) throw new Error(`Missing preset config: ${configPath}`);
		return JSON.parse(readFileSync(configPath, "utf8")) as PresetConfig;
	}

	function apply(name: string, ctx: ExtensionContext, persist = true): boolean {
		const preset = config?.presets[name];
		if (!preset) {
			ctx.ui.notify(`Unknown preset "${name}"`, "error");
			return false;
		}

		const excluded = new Set(preset.excludeTools ?? []);
		const prefixes = preset.excludeToolPrefixes ?? [];
		const tools = pi
			.getAllTools()
			.map((tool) => tool.name)
			.filter((name) => !excluded.has(name) && !prefixes.some((prefix) => name.startsWith(prefix)));

		pi.setActiveTools(tools);
		active = name;
		ctx.ui.setStatus("preset", ctx.ui.theme.fg("accent", `preset:${name}`));
		if (persist) pi.appendEntry("preset-state", { name });
		ctx.ui.notify(`Preset "${name}" activated (${tools.length} tools)`, "info");
		return true;
	}

	function restoredPreset(ctx: ExtensionContext): string | undefined {
		const entries = ctx.sessionManager.getBranch();
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (entry.type !== "custom" || entry.customType !== "preset-state") continue;
			const name = (entry.data as { name?: string } | undefined)?.name;
			if (name) return name;
		}
		return undefined;
	}

	pi.registerFlag("preset", {
		description: "Tool preset to activate",
		type: "string",
	});

	pi.registerCommand("preset", {
		description: "Switch tool preset: general, teacher, or wiki",
		handler: async (args, ctx) => {
			let name = args?.trim();
			if (!name) {
				const names = Object.keys(config?.presets ?? {});
				if (ctx.mode !== "tui") {
					process.stdout.write(
						`Active preset: ${active ?? "none"}\nActive tools: ${pi.getActiveTools().join(", ")}\nAvailable: ${names.join(", ")}\n`,
					);
					return;
				}
				name = (await ctx.ui.select("Select tool preset", names)) ?? "";
			}
			if (name) apply(name, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			config = loadConfig();
		} catch (error) {
			ctx.ui.notify(`Preset configuration failed: ${error}`, "error");
			return;
		}

		const flag = pi.getFlag("preset");
		const requested = typeof flag === "string" && flag ? flag : restoredPreset(ctx) ?? config.default;
		apply(requested, ctx, false);
	});
}
