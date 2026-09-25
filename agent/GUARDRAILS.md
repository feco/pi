# Non-sandbox tool guardrails

The child launcher `agent/bin/pi-subagent-safe` loads `block-env-reads.ts`, `confirm-reads-outside-cwd.ts`, and `confirm-writes.ts`. These guards also apply to interactive sessions that load them. `contained/` and `container/` are unchanged.

## Permissions

| Operation | Interactive session | Headless sub-agent |
| --- | --- | --- |
| Ordinary `read`/`edit`/`write` inside cwd | Automatic | Automatic |
| Valid file operation outside cwd | Explicit UI confirmation | Denied |
| Write active Pi code/configuration or nested `.pi`/`.agents` configuration | Explicit UI confirmation | Denied |
| Access Pi control state through file tools | Explicit UI confirmation | Denied |
| Bash, including shell searches | Explicit UI confirmation | Denied |
| Secured native `grep`/`find`/`ls` inside cwd | Automatic | Automatic |
| `contact_supervisor` | Communication only | Communication only |

There is no blanket unlock: consent covers one operation, not later calls. Mutation dialogs show the tool, resolved target and complete proposed arguments. Refusal denies the operation. The target, mutation arguments and file authority are rechecked after consent. The read extension owns read dialogs; the mutation extension owns edit/write dialogs, so each request gets one confirmation.

For example, creating `agent/agents/global-reviewer.md` requires confirmation in an interactive session; a child cannot grant itself that permission.

## Permanent restrictions

UI consent cannot override malformed paths, secret env/credential files, private keys, `.git` paths or cwd (including canonical aliases), sensitive `.aws`/`.ssh`/`.gnupg`/`.kube` directories, symlink descendants, hard-linked files or nonregular files. `read` and `edit` require an existing file; only `write` may create missing components. Reads beneath nested `.pi`/`.agents` directories remain denied.

The active installation is derived from the guard source, not caller input. Writes to its extensions/helpers, binaries, agent definitions, skills, installed packages (including canonical aliases), settings and manifests require consent. Pi control state includes `trust.json`, active `agent/sessions`, `agent/missions` and `.pi-subagents` directories. Ordinary `agent/tests` and documentation are not active configuration merely because the repository itself is named `.pi`.

Explicitly trusted Pi skill and installation documentation/package roots, plus `agent/SYSTEM.md` and `agent/GUARDRAILS.md`, retain automatic read access outside cwd. Only these configured read-root aliases may themselves be symlinks; their descendants are still checked. There is no broad `~/.pi` read exemption.

Ordinary source names such as `auth.ts`, `auth/handler.ts` and `src/dist/value.ts` are not secrets merely by name. Known credential/config data such as `auth.json`, `credentials.json` and secret `.env` variants remain blocked; nonsecret env examples/templates are allowed.

## Structured search

The same-name search overrides use Node filesystem APIs, not executables, shell parsing, PATH lookup or subprocesses. The policy blocks search until all three overrides register; a failed registration does not fall back to built-in search. Protected cwd checks run before traversal. Explicit outside, linked, restricted, nonregular, hard-linked or ignored targets fail rather than returning a misleading empty result.

Traversal skips protected names, Pi control-state roots (including canonical aliases), dependencies/runtime/build directories, and simple positive `.gitignore` rules. Search from within control state is denied before traversal; use an explicitly confirmed file read when access is needed. Nested ignore files apply. Unsupported syntax (including negation) or unsafe ignore files conservatively suppress the affected subtree; explicit targets with an unsafe ignore policy fail. This is **not full Git ignore compatibility**. `grep` uses JavaScript regex or literal matching; globs use Node `path.matchesGlob`. Extra tool parameters are rejected, never interpreted as executable options.

Limits: depth 32, 10,000 inspected entries, 1 MiB per file, 1,000 output lines/entries, 64 KiB output and 10 context lines. Large/binary files are skipped; limits can produce partial results. Search traversal exclusions do not automatically forbid direct access to ordinary source files.

## Limits and activation

This is **not an OS sandbox**. Concurrent filesystem changes can race validation and execution. Filename rules cannot detect arbitrary inline secrets. Synchronous regex matching can delay cancellation. Manually approved shells, human editors and other tools are outside the file-tool path guarantee; explicit approval of Bash is not a promise that its effects stay in cwd. Broad wiki, codegraph and index-writing auto-approvals have been removed.

Agent profiles must expose `grep`, `find` and `ls` to use native searches. A profile that exposes only Bash for searching cannot search autonomously under this policy; guard registration does not expand its tool permissions.

Existing sessions retain their loaded guards. Use `/reload` or start a new session after updating them. New children load the current files through the launcher. Maintaining guard source from an interactive agent requires explicit confirmation; no headless bypass switch exists.

Run the local suite with Node 22.22.3 or a compatible newer release:

```sh
node --experimental-strip-types --test agent/tests/guards.test.ts
```

Tests use repository-contained fixtures and inert shell strings; denial tests do not execute payloads.
