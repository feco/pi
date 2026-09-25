import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { fileAuthority } from "./lib/file-authority.ts";
import { secureSearch } from "./lib/secure-search.ts";

// ---------------------------------------------------------------------------
// Azure DevOps read classification
// ---------------------------------------------------------------------------

const AZURE_DEVOPS_READ_TOOLS = new Set([
	"mcp_azure_devops_core_list_projects",
	"mcp_azure_devops_core_list_project_teams",
	"mcp_azure_devops_core_get_identity_ids",
]);

const AZURE_DEVOPS_READ_ACTIONS = new Map<string, Set<string>>([
	["mcp_azure_devops_work", new Set([
		"list_iterations",
		"list_team_iterations",
		"get_team_settings",
		"get_team_capacity",
		"get_iteration_capacities",
	])],
	["mcp_azure_devops_wit_work_item", new Set([
		"get",
		"get_batch",
		"list_comments",
		"my",
		"list_revisions",
		"list_for_iteration",
		"get_type",
	])],
	["mcp_azure_devops_wit_query", new Set(["get", "get_results", "wiql"])],
	["mcp_azure_devops_wit_backlog", new Set(["list", "list_work_items"])],
	["mcp_azure_devops_repo_repository", new Set(["get", "list"])],
	["mcp_azure_devops_repo_pull_request", new Set(["get", "list", "list_by_commits"])],
	["mcp_azure_devops_repo_pull_request_org", new Set()],
	["mcp_azure_devops_repo_pull_request_thread", new Set(["list", "list_comments"])],
	["mcp_azure_devops_repo_branch", new Set(["get", "list", "list_mine"])],
	["mcp_azure_devops_repo_file", new Set(["get_content", "list_directory"])],
	["mcp_azure_devops_repo_search_commits", new Set()],
]);

export function isReadOnlyAzureDevOpsCall(toolName: string, input: unknown): boolean {
	if (AZURE_DEVOPS_READ_TOOLS.has(toolName)) return true;
	if (typeof input !== "object" || input === null) return false;

	if (toolName === "mcp_azure_devops_wit_work_item_attachment") {
		return (input as { savePath?: unknown }).savePath === undefined;
	}

	const allowedActions = AZURE_DEVOPS_READ_ACTIONS.get(toolName);
	if (allowedActions === undefined) return false;
	const action = (input as { action?: unknown }).action;
	if (allowedActions.size === 0) return action === undefined;
	return typeof action === "string" && allowedActions.has(action);
}

function validMutation(tool: "edit" | "write", input: Record<string, unknown>): boolean {
	if (tool === "write") return typeof input.content === "string";
	if (Array.isArray(input.edits)) {
		return input.edits.length > 0 && input.edits.every((edit: unknown) =>
			typeof edit === "object" && edit !== null &&
			typeof (edit as { oldText?: unknown }).oldText === "string" &&
			(edit as { oldText: string }).oldText.length > 0 &&
			typeof (edit as { newText?: unknown }).newText === "string");
	}
	// Older edit callers use the single-replacement form.
	return typeof input.oldText === "string" && input.oldText.length > 0 && typeof input.newText === "string";
}

export default function (pi: ExtensionAPI) {
	// Install the fail-closed policy first: partial registration must never expose built-in search.
	let searchReady = false;
	pi.on("tool_call", async (event, ctx) => {
		if (["grep", "find", "ls"].includes(event.toolName)) {
			return searchReady ? undefined : { block: true, reason: "Secure search registration failed" };
		}
		if (event.toolName === "contact_supervisor") return undefined;
		if (event.toolName === "read") return undefined; // The read extension owns read authorization and UI.
		if (event.toolName === "edit" || event.toolName === "write") {
			const tool = event.toolName;
			const originalPath = event.input.path;
			const decision = await fileAuthority(tool, originalPath, ctx.cwd);
			if (decision.kind === "deny") return { block: true, reason: decision.reason };
			if (!validMutation(tool, event.input)) return { block: true, reason: "Invalid mutation arguments" };
			if (decision.kind === "allow") return undefined;
			if (!ctx.hasUI) return { block: true, reason: `${tool} requires UI confirmation` };
			// Show the FULL payload, not a preview. Consent is bound to the displayed target and input.
			let payload: string;
			try { payload = JSON.stringify(event.input, null, 2); } catch {
				return { block: true, reason: "Mutation arguments cannot be displayed" };
			}
			const delimiter = "~".repeat(Math.max(3, ...Array.from(payload.matchAll(/~+/g), (match) => match[0].length + 1)));
			const confirmed = await ctx.ui.confirm(
				`Confirm ${tool}: ${decision.target}?`,
				`**Tool:** ${tool}\n\n**Actual target:** ${JSON.stringify(decision.target)}\n\n**Complete proposed arguments (including content):**\n\n${delimiter}json\n${payload}\n${delimiter}\n\nAllow this operation?`,
			);
			if (!confirmed) return { block: true, reason: "User rejected operation" };
			let current: string;
			try { current = JSON.stringify(event.input, null, 2); } catch {
				return { block: true, reason: "Mutation arguments changed after confirmation" };
			}
			const checked = await fileAuthority(tool, originalPath, ctx.cwd);
			if (event.input.path !== originalPath || current !== payload || checked.kind !== "confirm" || checked.target !== decision.target) {
				return { block: true, reason: "Mutation target or content changed or could not be revalidated after confirmation" };
			}
			return undefined;
		}
		// Explicitly classified web and Azure DevOps reads only; no wildcard or index-writing approvals.
		if (event.toolName === "web_fetch" || event.toolName === "web_search") return undefined;

		// Allow only explicitly classified Azure DevOps reads without confirmation.
		// Write tools, mixed-tool write actions, and future additions require confirmation.
		if (isReadOnlyAzureDevOpsCall(event.toolName, event.input)) {
			return undefined;
		}

		// In non-interactive mode, block anything not explicitly allowed above.
		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `Blocked "${event.toolName}" — confirmation required but no UI is available`,
			};
		}

		// Build a human-readable summary of the operation
		// Use markdown formatting (code blocks, headings) so the Pi TUI
		// renders it multi-line without truncation.
		let summary: string;
		try {
			if (event.toolName === "bash") {
				const cmd = event.input.command ?? "(unknown)";
				const timeout = event.input.timeout;
				const timeoutNote = timeout != null ? `\n**Timeout:** ${timeout}ms` : "";
				summary = `**Command:**\n\n\`\`\`sh\n${cmd}\n\`\`\`${timeoutNote}`;
			} else {
				// Generic: show formatted JSON with indentation for readability
				const str = JSON.stringify(event.input, null, 2);
				const maxLen = 2000;
				const display = str.length > maxLen ? str.slice(0, maxLen) + "\n\n*(truncated)*" : str;
				summary = `**Input:**\n\n\`\`\`json\n${display}\n\`\`\``;
			}
		} catch {
			summary = "*(unable to display arguments)*";
		}

		const confirmed = await ctx.ui.confirm(
			`Confirm ${event.toolName}?`,
			`The agent wants to execute:\n\n${summary}\n\nAllow this operation?`,
		);

		if (!confirmed) {
			const reason = await ctx.ui.input("Reason for blocking (optional):", "");
			return { block: true, reason: `User rejected this operation. Reason: ${reason || "(none given)"}` };
		}

		return undefined;
	});

	const string = { type: "string" };
	const integer = { type: "integer", minimum: 0, maximum: 1000 };
	const fields = {
		grep: { pattern: string, path: string, glob: string, ignoreCase: { type: "boolean" }, literal: { type: "boolean" }, context: { type: "integer", minimum: 0, maximum: 10 }, limit: integer },
		find: { pattern: string, path: string, limit: integer },
		ls: { path: string, limit: integer },
	};
	try {
		for (const name of ["grep", "find", "ls"] as const) {
			pi.registerTool({
				name,
				label: `Secure ${name}`,
				description: `Filesystem-only ${name} confined to non-secret regular files under the working directory; no processes. Uses JavaScript regex/glob semantics and conservative positive .gitignore rules. File read/edit/write reject linked files and secrets; protected Pi code, config and outside files require explicit UI consent.`,
				parameters: { type: "object", properties: fields[name], required: name === "ls" ? [] : ["pattern"], additionalProperties: false } as unknown as Parameters<ExtensionAPI["registerTool"]>[0]["parameters"],
				async execute(_id, params, signal, _onUpdate, ctx) {
					return { content: [{ type: "text" as const, text: await secureSearch(name, params as Record<string, unknown>, ctx.cwd, signal) }], details: undefined };
				},
			});
		}
	} catch {
		return; // Keep the blocking tool_call handler installed; never expose built-in search.
	}
	searchReady = true;
}
