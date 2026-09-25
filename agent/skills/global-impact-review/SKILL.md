---
name: global-impact-review
description: Review end-to-end impacts after implementation, including missed dependencies, existing data, format compatibility, rollout, and user follow-ups outside code. Used by the global-reviewer in the implement workflow.
---

# Global impact review

Check whether a locally correct implementation delivers the intended behavior across the existing system. Work read-only; the orchestrator owns repairs and user decisions. Ground findings in repository evidence, distinguishing confirmed omissions from conditional risks. Prefer the smallest sufficient correction over speculative new requirements.

1. **Establish scope.** Read the user goal, approved scope and decisions, change summary/diff, verification results, and applicable repository instructions. Identify missing context explicitly; ask the orchestrator for material inputs rather than assuming them. Done when the intended outcome and review limits are clear.
2. **Trace beyond the diff.** Inspect actual entry points, producers, transformations, persistence, consumers, and user-facing outputs, including relevant unchanged paths. Follow repository contracts, documentation, and tests rather than relying only on the implementation summary. Check each applicable dimension below; mark others not applicable with a short reason:
   - Existing versus newly created data: schema/version compatibility, backfill, reindexing, reingestion, stale caches, partial updates, and repeatability.
   - Supported variants: other document formats, providers, clients, import paths, configurations, and legacy records; missing metadata and fallback behavior.
   - End-to-end contracts: API/schema changes, downstream consumers, ownership, permissions, and whether required information survives every transformation.
   - Delivery and operation: deployment ordering, mixed versions, migration/rollback, failure recovery, observability, and material resource/cost implications.
   - Product completion: documentation, user communication, manual operations, acceptance coverage, and follow-up work needed outside this code change.

   Example: adding PDF text positions requires checking extraction through retrieval/display, whether stored chunks lack positions and need reingestion, and how already-supported non-PDF inputs behave. It does not imply adding new formats or running a production reingestion.

   Done when relevant flows and dimensions have an evidence-backed disposition, with uninspected areas identified as limits rather than declared safe.
3. **Classify and report.** Return concise sections:
   - **Coverage:** traced flows, inspected file paths, applicable dimensions, and review limits.
   - **Corrections:** high-confidence omissions necessary for the approved behavior, with evidence (path and symbol/line), affected scenario, consequence, smallest repair, and verification needed.
   - **Decisions/blockers:** unresolved product/architecture choices or prerequisites that prevent safe completion; state the question and recommended option for the user.
   - **User follow-ups:** operational actions, conditional cautions, or future stories outside the approved code scope. For each, state evidence, why/when it matters, the next action, and whether it is required before rollout or optional later. Mark uncertainty and unknown ownership explicitly.

   Use “none” for empty sections. Keep pre-existing issues separate unless this change makes them relevant. A necessary migration or rollout prerequisite belongs among blockers when deferring it would make delivery unsafe; calling it a follow-up must not hide that dependency. Suggest actions, but do not execute migrations, create tickets, or expand scope. Done when every finding has a disposition and the orchestrator can distinguish code repairs from user decisions and final-message reminders.
