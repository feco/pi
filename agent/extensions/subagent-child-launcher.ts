import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI) {
	process.env.PI_SUBAGENT_PI_BINARY = join(
		process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
		"bin",
		"pi-subagent-safe",
	);
}
