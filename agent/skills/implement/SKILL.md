---
name: implement
description: "Use before editing code to implement any requested feature, bug fix, refactor, ticket, spec, plan, or behavior change."
---

Implement the work described by the user in the spec or tickets. Before changing code, discover the project's applicable implementation, testing, verification, documentation, and versioning instructions — they are authoritative throughout.

Work through these steps in order. Do not start a step until the previous step's completion criterion is met; "the tests will be added later" means the work is unproven, not mostly done.

Use the role-specific agents when delegating: `test-writer` for tests, `implementer` for production code, `code-reviewer` for correctness, `test-reviewer` for test quality, and `thermonuclear-reviewer` for structural quality. Reserve `delegate` for work outside these roles. Exceptionnaly for tiny changes you can just do the update of file directly without the sub agents to save on time and cost.

1. **Red/green slices.** Follow the `tdd` skill and complete each vertical slice before starting the next:
   1. Explain what is your plan to the user. Make it visual when relevant. And confirm that change is ok.
   2. Dispatch `test-writer` to write exactly one behavior-focused test at a confirmed seam and run the narrowest relevant command. Wait for it to finish. Done when its handoff shows that the new test fails for the intended reason. Do not force tests when not relevant.
   3. Dispatch `implementer` to make that test pass with the minimum production-code change. Wait for it to finish. Done when its handoff shows that the focused test passes and the change meets the full rules at of the thermo-nuclear-code-quality-review skill. Implementer should report implementation that might need an ADR to add it later in the documentation, only if the change is significant enough and that decision is likely to need explanation later.
   4. Repeat for the next behavior only after the current slice is green.

   Give each child only its role's phase: a `test-writer` task authorizes test changes but no production-code implementation; an `implementer` task authorizes production-code changes for an already-red test but no new behavior tests. Never combine test writing and production-code implementation in one child task or run. Throughout implementation, hunt the code-judo move that deletes whole branches, helpers, or layers; keep files under 1k lines; never add special-case branches or one-off flags to unrelated or shared flows; prefer direct, boring code and reuse the existing canonical helper in the owning layer. Done when every planned slice is green.
2. **Verify.** Run the project's required focused and full verification commands. Done when every command passes.
3. **Review once, in parallel.** After all slices are implemented and verified, dispatch in one fresh-context workflow:
   - `code-reviewer` to review the complete tests and implementation for concrete correctness, spec, and standards defects;
   - `test-reviewer` to review the changed tests and meaningful test gaps against the `tdd` skill; and
   - `thermonuclear-reviewer` to review the complete change for structural regressions and clear, material simplifications.

   Wait for all reviewers, then synthesize their reports. Accept only blockers and high-confidence defects introduced by the change. If accepted findings exist, perform one role-separated repair pass, update tests when behavior changes, and rerun only the checks affected by the repair. Do not start another open-ended review cycle. Done when accepted findings are fixed and affected checks pass. If a blocker remains or the reviewers disagree on a product or architecture decision, stop and ask the user.
4. **Documentation.** Follow the project's documentation instructions and verify that its documentation reflects the latest change, updating it when needed. Done when the documentation is current.
5. **Verification** Ask for the user to check that everything is correct. Wait for the confirmation.
6. **Commit.** Commit the complete verified, reviewed, and documented change with a focused message.
7. Suggest a push and pull request creation after a vertical slice is fully implemented.

Manage your context with subagents. Each role-specific agent above already preloads its required skill; do not attach the skill again at dispatch. Use read-only agents for exploration and scoping, one writer at a time, and keep your context for orchestration, synthesis, and decisions.
