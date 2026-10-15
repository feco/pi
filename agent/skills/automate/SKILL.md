---
name: automate
description: Mine the current and recent agent sessions for repeated, slow, or error-prone steps, by the user or the agent, and for gaps in what the agent could verify or know. Propose scripts, repository changes, skills, instructions, harness extensions, or new tools for the agent. Use when the user asks what could be automated, sped up, or improved in their workflow.
disable-model-invocation: true
---

# Automate

Find steps that the user or the agent repeat, wait on, or get wrong, and places where the agent lacked a way to check its work or the context to get it right. Propose the cheapest durable fix for each. This skill proposes. Build only what the user picks.

## 1. Set the scope

Default to the current session plus the last 5 sessions for the current working directory. Widen to other projects or a date range only when the user asks. Read the repository's instructions files (for example `AGENTS.md` or `CLAUDE.md`) and list the available skills, tools, and MCP servers, so you know what already exists.

## 2. Gather the sessions

The current session is already in your context; use it directly. For earlier sessions, run the bundled script from the project's working directory:

```sh
python3 <this skill's directory>/scripts/session_digest.py --recent 6
```

It finds the newest sessions for the working directory in every harness store it knows, then prints one line per user message, assistant message, tool call, and failed tool result. Transcripts are large, so read this digest, not the raw files. Open a raw transcript only to check a specific step.

- `--list` prints the session paths without the digest.
- `--cwd DIR` targets another project, and `--all-projects` searches every project.
- Pass transcript paths as arguments to digest specific files.

If the script finds no sessions, the harness stores them somewhere it doesn't know. Look in the harness documentation or environment variables, then pass the files as arguments.

Transcripts can contain secrets and personal data. Never copy them into a proposal.

## 3. Find the candidates

Look for these signals, in the user's steps and in the agent's:

- **Repeated sequences.** The same commands, edits, or lookups in several sessions, or several times in one.
- **Repeated instructions.** The user restates the same rule or correction ("don't…", "remember to…") or retypes the same prompt.
- **Rediscovery.** Each session spends calls finding the same fact: how to run the tests, where the config lives, which command builds the project.
- **Friction.** Failed tool calls and retries, missing tools, permission denials, interrupted requests, slow commands, very large outputs.
- **Manual workflows.** Multi-step routines such as releases, deploys, data refreshes, or setup, or steps the user says they did by hand.
- **Repository friction.** No script or task-runner target for a common action, slow or flaky tests, boilerplate written again and again, missing test helpers or fixtures, lint errors a formatter could fix, docs that don't say how to run things, code the agent repeatedly misreads.
- **Unverified work.** The agent claimed success without evidence, the user found the bug instead, or the agent couldn't see the result: a UI it couldn't look at, logs or a database it couldn't query, a deploy or CI run it couldn't check.
- **Missing context.** The agent guessed at an API, used outdated docs, asked the user for something a tool could have fetched, or the user pasted in the same kind of information (errors, tickets, designs, screenshots) by hand.

Count how often each candidate occurs and note the sessions where it does. One occurrence is rarely worth automating unless it was costly.

## 4. Pick the fix

Choose the cheapest fix that removes the step for good. Use deterministic code for mechanical steps, and instructions or skills for steps that need judgment. Before proposing anything new, check whether something existing already covers the step and could be improved instead.

- **Repository:** a script, a task-runner target, a test helper or fixture, a code generator, lint or formatter config, a CI check, a refactor, or a docs fix.
- **Instructions file:** one line in the project or user instructions for a fact the agent keeps rediscovering.
- **Skill:** a new skill or an improvement to an existing one, for a repeated workflow that needs judgment. Keep skills independent of any one harness.
- **Agent tool:** a new tool that lets the agent verify its work or fetch context itself: a CLI, an MCP server, browser automation or screenshots, a language server or type checker, read access to logs, a database, CI, or the issue tracker, or a docs lookup. Name the concrete tool, say what it unlocks, and say what access or install it needs.
- **Harness:** a hook, an extension or plugin, a custom command, a permission allowlist, or a settings change, for steps the harness should do or allow automatically. Check the harness documentation for what it supports.

## 5. Report

Rank the proposals by time or errors saved for the effort, and keep the 5–10 strongest. For each, give:

- **What:** the step and who performs it.
- **Evidence:** how often it occurred, and in which sessions.
- **Fix:** the solution type, where it lives (path or harness setting), and a short sketch: the script outline, the skill's name and description, or the hook's trigger and action.
- **Payoff and cost:** what it saves, the effort to build it, and any risk.

Then ask the user which proposals to build. Build nothing before they choose.
