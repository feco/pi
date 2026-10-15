---
name: tdd
description: Test-driven development. Use when the user wants to build features or fix bugs test-first, mentions "red-green-refactor", or wants integration tests.
---

## Repository rules

Before acting, locate and read repository and harness instructions (for example `AGENTS.md`, `CLAUDE.md`, and documents they reference). Those instructions are authoritative for paths, formats, tools, workflows, testing, documentation, versioning, issue tracking, and Git operations. Apply this skill only where they are silent; if they conflict or remain ambiguous, stop and ask the user.

# Test-Driven Development

TDD is the red → green loop. This skill is the reference that makes that loop produce tests worth keeping: what a good test is, where tests go, the anti-patterns, and the rules of the loop. Every section applies on every cycle — consult them before and during the loop, not after.

When exploring the codebase, discover and read the repository's applicable terminology and decision documentation so test names and interface vocabulary match the project's language and recorded constraints.

## What a good test is

Tests verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't. A good test reads like a specification — "user can checkout with valid cart" tells you exactly what capability exists — and survives refactors because it doesn't care about internal structure.

Keep tests deterministic, independent of execution order and shared state, and fast enough for their layer. Control time and randomness, and reset or isolate fixtures and test data. Choose scenarios by risk: cover meaningful boundaries, invalid inputs, errors, and failure paths as well as the happy path. Use coverage to find gaps, not to chase a percentage. Structure tests so setup, action, and expected outcome are easy to distinguish.

For integration tests, exercise the real boundary under test (such as the production-compatible database engine or service contract); replace unrelated external systems when that makes the test more focused. Isolate data per test/run and clean it up. Where services communicate, verify their shared contract and exercise critical paths against real implementations as practical. Run the appropriate focused tests during development and the repository's required suite in CI.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for mocking guidelines.

## Seams — where tests go

A **seam** is the public boundary you test at: the interface where you observe behavior without reaching inside. Tests live at seams, never against internals.

Before writing any test, name the seams under test. You can't test everything: picking the seams up front puts testing effort on the critical paths and complex logic instead of every edge case. Ask: "What's the public interface, and which seams carry the risk?"

## Fixing a bug

1. Reproduce the bug and state the intended behavior, the current behavior, and the smallest observable reproduction.
2. Write the smallest regression test, at the closest existing seam, that would have caught the bug. It encodes intended behavior, not the current implementation.
3. Run the loop below. If the bug is flaky, make the test deterministic and note which signal it locks down.
4. If the bug exposes a broader class of failures, land the focused regression test first, then add sibling coverage.

## Anti-patterns

- **Implementation-coupled** — mocks internal collaborators, tests private methods, or verifies through a side channel (querying the database instead of using the interface). The tell: the test breaks when you refactor but behavior hasn't changed.
- **Tautological** — the assertion recomputes the expected value the way the code does (`expect(add(a, b)).toBe(a + b)`, a snapshot derived by hand the same way, a constant asserted equal to itself), so it passes by construction and can never disagree with the code. Expected values must come from an independent source of truth — a known-good literal, a worked example, the spec.
- **Horizontal slicing** — writing all tests first, then all implementation. Bulk tests verify _imagined_ behavior: you test the _shape_ of things rather than user-facing behavior, the tests go insensitive to real changes, and you commit to test structure before understanding the implementation. Work in **vertical slices** instead — one test → one implementation → repeat, each test a **tracer bullet** that responds to what the last cycle taught you.

## Rules of the loop

- **Red before green.** Write the failing test first, then only enough code to pass it. Don't anticipate future tests or add speculative features.
- **Red for the right reason.** Run the new test before changing production code and read the failure. It must fail because the behavior is missing or wrong, not because of an import error, a typo, or a broken fixture. If it passes or fails for an unrelated reason, fix the test first.
- **Green, then nearby.** After the change, rerun the new test and the tests around the code you touched.
- **One slice at a time.** One seam, one test, one minimal implementation per cycle.
- **Tests encode intent.** Never change a test to match a wrong implementation. Weaken or delete an existing assertion only when the intended behavior has changed, and say why.
- **Refactor only on green.** Refactor once the tests pass, never inside a red → green step.

## When a failing test is impractical

Prefer no new test over a bad one: a test that mostly exercises mocks, encodes implementation details, depends on timing or global state, or needs expensive infrastructure for a small change. In that case, use the closest executable check instead (a targeted script, a reproduction command, browser automation, or a log assertion), and tell the user why you skipped the test and what you ran instead.

## Report the evidence

End with evidence, not just the outcome:

- The failing-before test or check, and the failure it produced.
- The passing-after run, and any nearby tests run.
- Any gap: where failing-before evidence could not be shown, why, and which check replaced it.
