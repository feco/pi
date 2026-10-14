---
name: implement
description: "Implements a feature, bug fix, refactor, ticket, spec, or plan test-first, from clarifying questions to commit. Use before editing code to change behavior."
---

You are the **orchestrator**: you decide, brief, run commands children cannot, and commit. One **writer** edits files at a time — a fresh `implementer` per slice, or you directly for a tiny change. Project instructions on implementation, testing, documentation and versioning take precedence; find them first.

Each step ends on a **Done when** line; start the next step only then. Untested work is unproven, not mostly done.

## Agents

- `implementer` — tests and production code for one slice.
- `code-reviewer` — the combined review every change gets, tiny ones included.
- `thermonuclear-reviewer` / `test-reviewer` — specialist review for structural / test risk.
- `global-reviewer` — optional deeper check of the direction in step 2.
- `delegate` — work outside these roles.

Each agent preloads its own skills. Scout with read-only agents and keep your own context for decisions.

## Steps

1. **Mini-grill.** Read the relevant code, then ask 1–3 decision questions in chat, each with a recommended answer. Reuse decisions already settled, including in an earlier `grill-with-docs`; when none remain, ask the user to confirm scope. Stay in chat; the user starts `grill-with-docs` themselves for larger work.
   **Done when** no blocking decision remains.

2. **Plan.** Run `global-impact-review` on the chosen direction and let its conclusion (proceed / reuse / redirect / clarify) shape the plan. Present an ASCII sketch of the affected flow, the red/green slices, verification commands, any specialist review with its reason, and any migration, rollout or user action. Come back here only if scope or a material decision changes.
   **Done when** the user approves the plan. Edits start after approval.

3. **Slices.** For each slice, dispatch a fresh `implementer` with the plan, the slice's behavior and the earlier slice commits, following `tdd`:
   1. **Red** — one behavior test at a confirmed seam, failing for the intended reason. Skip when a test adds no value.
   2. **Green** — the minimal production change that passes it and meets `thermo-nuclear-code-quality-review`. The implementer flags any decision worth an ADR.
   3. **Commit** — you commit the slice's test and code only.

   When the child cannot run a command, it returns the command; you run it and resume the same child with the result. Advance on the expected result only; anything else keeps the writer on the current phase.
   **Done when** every slice is green and committed.

4. **Verify.** Run the project's full verification. On failure, one fresh implementer makes one targeted repair, committed separately; a second failure stops the work and you report.
   **Done when** every command passes.

5. **Review.** Dispatch one fresh `code-reviewer` covering correctness, tests, maintainability, fit with the approved direction and downstream effects. Add a specialist when the blast radius calls for it — security/auth, data migrations or persisted formats, public or cross-service contracts, large structural refactors — using `thermonuclear-reviewer`, `test-reviewer`, or a read-only reviewer with a risk-focused brief. Brief reviewers with the goal, approved decisions and the step 2 conclusion.

   Merge the findings. Fix only blockers and high-confidence defects against the approved behavior: one repair pass by a fresh implementer (or you, for a tiny change), then rerun the affected checks. Record every finding's disposition. Keep operational actions, cautions and future stories as follow-ups for the user. Scope changes, product or architecture decisions, an unfinished review or reviewer disagreement go to the user.
   **Done when** accepted findings are fixed and their checks pass.

6. **Documentation.** Update the docs the project's instructions call for.
   **Done when** the docs describe the change.

7. **Handoff.** Summarize what changed and how it was verified. List follow-ups with action, why or when it matters, and whether it is required before rollout. Separate finished code from pending operational work.
   **Done when** the user confirms the result.

8. **Commit** the review repairs and documentation.
   **Done when** nothing from this work is uncommitted.

9. **Push** the branch once, then suggest a pull request. Repeat open follow-ups in this final message.
