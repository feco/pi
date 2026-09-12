import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolve } from "node:path";
import { homedir } from "node:os";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "read") {
			return undefined;
		}

		const pathArg = event.input.path as string;
		const cwd = resolve(ctx.cwd);
		const target = resolve(cwd, pathArg);

		// Allow reads inside the working directory
		const sep = target.startsWith(cwd + "/") || target === cwd;
		if (sep) {
			return undefined;
		}

		// Allow reads inside the pi installation directory (no confirmation needed)
		const piDir = resolve(homedir(), ".nvm/versions/node/v22.22.3/lib/node_modules/@earendil-works");
		if (target.startsWith(piDir + "/") || target === piDir) {
			return undefined;
		}

		// Allow reads inside ~/.pi (no confirmation needed)
		const dotPiDir = resolve(homedir(), ".pi");
		if (target.startsWith(dotPiDir + "/") || target === dotPiDir) {
			return undefined;
		}

		// Allow reads inside the pi-node installation directory (no confirmation needed)
		const piNodeDir = "/var/home/goulven/.local/share/pi-node/node-v22.22.3-linux-x64/lib/node_modules/@earendil-works";
		if (target.startsWith(piNodeDir + "/") || target === piNodeDir) {
			return undefined;
		}

		// Outside working directory — require confirmation
		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `Blocked reading "${pathArg}" — it is outside the working directory and confirmation requires a UI.`,
			};
		}

		const confirmed = await ctx.ui.confirm(
			"Confirm read outside working directory?",
			`The agent wants to read:\n\n  ${pathArg}\n\nResolved path:\n  ${target}\n\nThis is outside the working directory:\n  ${cwd}\n\nAllow this operation?`,
		);

		if (!confirmed) {
			return { block: true, reason: "User rejected this operation." };
		}

		return undefined;
	});
}
