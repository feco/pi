---
name: grill
description: Grill the user relentlessly about a plan, decision, or idea, check the direction against the broader repository, and record the outcome in the project's docs when the project has a convention for it. Use when the user wants to stress-test their thinking or sharpen a plan or design, or uses any 'grill' trigger phrase.
---

# Grill

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

## Work in rounds

The **frontier** is every decision whose prerequisites are already settled — the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Each question should be formatted like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Each round the user answers reshapes the tree — settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (files, code, docs, tools), look it up — don't ask the user for anything you could find yourself. Don't block on it: a pending lookup is an unsettled prerequisite, so only the questions downstream of it wait; ask the rest of the frontier now. The _decisions_ are the user's — put each to them and wait.

## Check the direction against the broader system

Once a round has settled the desired outcome and the proposed approach (usually the first round), step back and ask: **"Knowing the broader system, is this the right work to do, in the right place?"** — not merely "Can this component implement it?" Treat the user's proposal as input, not proof that it is sound, and keep the desired outcome apart from the suggested solution.

Inspect the relevant modules, services, entry points, end-to-end flows, contracts, stores, ownership, and recorded architecture decisions, including outside the proposed change area. Follow the connections that matter to the decision rather than reading the whole repository. Check:

- **Reuse:** Does another component already provide this capability? Could an existing tool, contract, or workflow solve the problem with less change?
- **Ownership:** Is this the right layer or service? Does it fix the underlying problem or compensate for a mistake elsewhere?
- **Consistency:** Would it duplicate state, sources of truth, business rules, contracts, or user workflows? Does it fit the recorded architecture?
- **Completeness:** Does the flow deliver the outcome across supported inputs, configurations, producers, and consumers, not only the local happy path?
- **Feasibility:** Do existing data, compatibility, permissions, migration and rollback, deployment ordering, or manual operations change the approach?

Ground each answer in the paths and contracts you inspected, and name uninspected areas as limits, not as evidence that no conflict exists. Conclude **proceed**, **reuse**, **redirect**, or **clarify**, and put that conclusion to the user as a question in the next round, with the smallest sufficient approach as your recommended answer. Don't expand scope or run operations.

Repeat the check only when new evidence challenges the direction. Reopen a settled decision only when concrete repository evidence changes its basis.

## Record the outcome in the docs

Before the first round, look for the project's documentation instructions and any convention for a gap artifact: a document that records the gap between the current and the intended state of an initiative. If the project has one, or the user asks for a document, create or open the initiative's gap artifact before recording decisions. Otherwise, keep the session in chat.

When you keep a gap artifact, update it after every round with the durable outcome: the problem, intended end state, settled decisions, direction check conclusion, open questions, dependencies, rejected options, and scope boundaries. Keep it concise: don't copy the conversation verbatim or add facts the user did not establish.

Use the project's terminology and document locations. Follow its frontmatter, navigation, linking, and validation requirements. If the project requires a separate decision record, link it from the gap artifact and keep the decision's execution impact in the gap.

## Finish

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. End with the direction conclusion and any required migration, rollout, documentation, or user actions, separating prerequisites from optional later work. If you kept a gap artifact, make its open items match the unresolved frontier and tell the user where you updated it.

Do not act on the outcome until the user confirms you have reached a shared understanding.
