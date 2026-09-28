---
name: global-impact-review
description: Challenge a proposed direction against the broader repository or monorepo before plan approval, including after grill-with-doc. Check existing capabilities, ownership, sources of truth, and architectural fit.
---

# Global direction check

Ask **“Knowing the broader system, is this the right work to do, in the right place?”**, not merely “Can this component implement the feature?” The orchestrator owns this check after clarification and before plan approval. Use `global-reviewer` only when deeper read-only investigation is useful. No implementation or finished diff is required.

1. **Establish the outcome.** Read the user goal, settled decisions, proposed approach, and applicable repository instructions. Treat an earlier grilling session as input, not proof that the proposed direction is sound. Distinguish the desired outcome from the suggested solution. Done when the outcome, constraints, and remaining assumptions are explicit.
2. **Step back across the repository.** Inspect relevant services/modules, entry points, end-to-end flows, contracts, stores, ownership, and architectural decisions, including outside the proposed change area. Scale the investigation to the decision: follow relevant connections rather than exhaustively reading the monorepo. Check:
   - **Reuse:** Does another component already provide this capability? Could an existing tool, contract, or workflow solve the problem with less change?
   - **Ownership:** Is this the right layer or service? Are we fixing the underlying problem or compensating for a mistake elsewhere?
   - **Consistency:** Would the approach duplicate state, sources of truth, business rules, contracts, or user workflows? Does it fit the broader product and recorded architecture?
   - **Completeness:** Does the proposed flow deliver the outcome across supported inputs, configurations, producers, and consumers, rather than only the local happy path?
   - **Feasibility:** Do existing data, compatibility, permissions, migration/rollback, deployment ordering, or required manual operations materially change the approach?

   Ground conclusions in inspected paths and contracts. Mark uninspected areas and uncertain ownership as limits, not evidence that no existing capability or conflict exists. Done when applicable questions have evidence-backed answers and material unknowns are explicit.
3. **Recommend a direction.** Return a short conclusion: **proceed**, **reuse**, **redirect**, or **clarify**. Include the supporting paths/flows, the smallest sufficient approach and its tradeoffs, material decisions or blockers, and investigation limits. Carry necessary migration, rollout, documentation, and user actions into the proposed plan, distinguishing required prerequisites from optional later work. Do not expand scope or execute operations automatically.

   The orchestrator incorporates this conclusion into the existing plan-approval step; there is no separate approval ceremony. Reopen settled decisions only when concrete repository evidence changes their basis. Done when the user can approve a coherent approach, with required follow-ups and material unknowns visible.

After implementation, the normal code reviewer checks delivery against the approved direction and concrete downstream consequences. Repeat this broader direction check only if new evidence materially challenges the approach.
