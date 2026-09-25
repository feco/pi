import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { fileAuthority } from "./lib/file-authority.ts";

// Only this handler owns read decisions; the mutation handler must not prompt for reads.
export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "read") return undefined;
		const originalPath = event.input.path;
		const decision = await fileAuthority("read", originalPath, ctx.cwd);
		if (decision.kind === "deny") return { block: true, reason: decision.reason };
		if (decision.kind === "allow") return undefined;
		if (!ctx.hasUI) return { block: true, reason: "Read requires UI confirmation" };
		const confirmed = await ctx.ui.confirm(
			`Confirm read: ${decision.target}?`,
			`**Tool:** read\n\n**Actual target:** ${JSON.stringify(decision.target)}\n\nAllow this read?`,
		);
		if (!confirmed) return { block: true, reason: "User rejected read" };
		const checked = await fileAuthority("read", originalPath, ctx.cwd);
		if (event.input.path !== originalPath || checked.kind !== "confirm" || checked.target !== decision.target) {
			return { block: true, reason: "Read target changed or could not be revalidated after confirmation" };
		}
		return undefined;
	});
}
