import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function expandHomeAndURL(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
	return value.startsWith("file://") ? fileURLToPath(value) : value;
}

// Pi-compatible macOS/Linux file-tool normalization; keep the executor contract test in sync.
export function expandPath(filePath: string): string {
	return expandHomeAndURL(filePath.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, ""));
}

export function resolveToCwd(filePath: string, cwd: string): string {
	return path.resolve(expandHomeAndURL(cwd), expandPath(filePath));
}
