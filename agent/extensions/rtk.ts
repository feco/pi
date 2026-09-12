import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RTK_MIN_VERSION = "0.23.0";

// Compare two semver strings: returns -1, 0, or 1.
function semverCompare(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const aVal = partsA[i] ?? 0;
    const bVal = partsB[i] ?? 0;
    if (aVal < bVal) return -1;
    if (aVal > bVal) return 1;
  }
  return 0;
}

async function checkRtk(pi: ExtensionAPI): Promise<boolean> {
  const result = await pi.exec("rtk", ["--version"], { timeout: 2000 });
  if (result.code !== 0) return false;
  const version = result.stdout.trim().replace(/^rtk\s+/, "").split(" ")[0];
  return semverCompare(version, RTK_MIN_VERSION) >= 0;
}

// Exit 3 means "rewrite, but keep confirmation"; Pi's confirmation guard remains authoritative.
async function rewriteCommand(pi: ExtensionAPI, command: string, signal?: AbortSignal): Promise<string> {
  const result = await pi.exec("rtk", ["rewrite", command], { timeout: 2000, signal });
  const rewritten = result.stdout.trim();
  return (result.code === 0 || result.code === 3) && rewritten ? rewritten : command;
}

export default async function (pi: ExtensionAPI) {
  const rtkAvailable = await checkRtk(pi);

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    // isToolCallEventType narrows `event` itself; return value is truthy/falsy
    if (!isToolCallEventType("bash", event)) return;

    const input = event.input as { command?: string };
    const command = input?.command;
    if (!command || typeof command !== "string") return;

    // Skip RTK meta-commands and RTK-disabled commands
    if (command.startsWith("rtk ") || command.trimStart().startsWith("rtk/")) return;
    if (command.includes("RTK_DISABLED=1")) return;

    if (!rtkAvailable) return;

    const rewritten = await rewriteCommand(pi, command, ctx.signal);
    if (rewritten && rewritten !== command) {
      input.command = rewritten;
    }
  });

  // Register a command to quickly check status
  pi.registerCommand("rtk", {
    description: "Check RTK status and installation",
    handler: async (_args, ctx) => {
      const version = await pi.exec("rtk", ["--version"], { timeout: 2000 });
      if (version.code !== 0) {
        ctx.ui.notify("RTK is unavailable or older than the supported version", "error");
        return;
      }
      ctx.ui.notify(version.stdout.trim(), "info");
      const gain = await pi.exec("rtk", ["gain"], { timeout: 5000 });
      if (gain.stdout.trim()) ctx.ui.notify(gain.stdout.trim(), gain.code === 0 ? "info" : "warning");
    },
  });
}
