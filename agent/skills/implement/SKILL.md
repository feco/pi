---
name: implement
description: "Implements a feature, bug fix, refactor, ticket, spec, or plan test-first, from shared understanding to a verified, reviewed, committed change. Use before editing code to change behavior."
---

# Implement

Take a change from a shared understanding to verified, reviewed, committed code. Project instructions on implementation, testing, documentation, versioning, and Git take precedence over this skill; read them first.

Each step ends on a **Done when** line; start the next step only then. Untested work is unproven, not mostly done.

## Related skills

Read these files when a step calls for them; don't assume they are already loaded.

- [grill](../grill/SKILL.md) and [wayfinder](../wayfinder/SKILL.md): reaching a shared understanding.
- [tdd](../tdd/SKILL.md): the red → green loop and what a good test is.
- [thermo-nuclear-code-quality-review](../thermo-nuclear-code-quality-review/SKILL.md) and [review/references/clarity.md](../review/references/clarity.md): the code standard to write and simplify to.
- [verify](../verify/SKILL.md): proving the change works.
- [review](../review/SKILL.md): the final review.
- [technical-writing](../technical-writing/SKILL.md) and [unslop](../unslop/SKILL.md): every piece of prose.

## Writing

Commit messages, documentation, and the final summary follow `technical-writing` and `unslop`.

## Steps

1. **Understand and plan.** Read the relevant code, then size the work:
   - **Tiny** (one behavior, obvious fix): confirm the scope in one line.
   - **Normal:** reuse the decisions of an earlier `grill` session when they settle the path forward. Otherwise, run `grill` first.
   - **Large** (several open decisions or unknowns): run `wayfinder` and stop. Implement its tickets later, one session each.

   Unless a `grill` session already checked the direction, step back across the repository: does another component already provide this, is this the right layer or service, and would it duplicate state, rules, or contracts? Ground the answer in inspected paths.

   Make sure the work happens on a branch and the working tree holds no unrelated changes. Then present the plan: an ASCII sketch of the affected flow, the slices with their seams, the verification commands, and any migration, rollout, or user action.
   **Done when** the user approves the plan. Edits start after approval.

2. **Slices.** Before the first slice, read `tdd`, the repository's code standards, and the standards in `thermo-nuclear-code-quality-review`, so the code meets the review bar on the first pass. For each slice:
   1. **Red:** one behavior test at the slice's seam, failing for the intended reason. Skip only when a test adds no value, and say why.
   2. **Green:** the minimal production change that passes it.
   3. **Simplify:** remove duplication and needless complexity, guided by the Preferred Remedies in `thermo-nuclear-code-quality-review`. Leave the tests untouched; if a test must change, the behavior changed, so go back to red. Rerun the tests.
   4. **Commit:** run the fast checks (format, lint, type check, and the tests near the change), then commit the slice's test and code only.

   After the last slice, run one simplify pass over the whole diff to catch duplication between slices, and commit it.
   **Done when** every slice is green, simplified, and committed.

3. **Verify.** Follow `verify`: the required checks, then the changed behavior in the running software. On failure, loop back.
   **Done when** every required check passes and the changed behavior has been seen working.

4. **Documentation.** Update the docs the project's instructions call for. When the project keeps decision records (ADRs) and the work made a decision worth one, write it. Commit.
   **Done when** the docs describe the change and are committed.

5. **Review.** Review the whole diff with fresh context, following `review`, and give it the goal, the approved plan, and the direction check from step 1. On a P0–P2 defect, loop back. Scope changes and product or architecture decisions go to the user instead.
   **Done when** the review reports no P0–P2 defect.

   **Loop back:** treat each defect found in step 3 or 5 as a new slice in step 2, starting with a test that reproduces it, then run steps 3 to 5 again. Stop and report when the same defect returns after a fix, or after 3 loops.

6. **Summary.** Tell the user:
   - What changed, slice by slice, and how it was verified.
   - The review findings not fixed: P3 defects, improvements, and open questions.
   - The tasks you could not do, and what you need from the user to do them.
   - The next steps for this environment, such as pushing the branch, opening a pull request, deploying, running a migration, or manual testing.
