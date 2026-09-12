# Correctness and maintainability review

Apply these as prompts for investigation, not a checklist to mechanically report.

## Intent and behavior

- Does the change implement its stated intent and only the intended scope?
- Trace normal, empty, null/missing, boundary, malformed, duplicate, retry, cancellation, timeout, and partial-failure paths when applicable.
- Check state transitions, invariants, ordering assumptions, idempotency, cleanup, rollback, and error propagation.
- For concurrent code, reason about races, deadlocks, atomicity, stale reads, lifecycle, cancellation, and resource ownership.
- Confirm changed APIs preserve documented contracts: inputs, outputs, errors, side effects, defaults, and ordering.

## Integration and compatibility

- Inspect callers and consumers, not just the changed function.
- Check backward compatibility for public APIs, stored data, config, environment variables, CLI flags, wire formats, and events.
- For schema/data migrations, assess mixed-version operation, existing rows, reversibility, locking, transactional safety, and rollout order.
- For dependency changes, inspect manifest and lockfile together; assess changed transitive packages, runtime/toolchain constraints, license/project policy, and migration notes available locally. Never fetch release notes.
- Confirm generated artifacts correspond to their source changes and are not hand-edited inconsistently.

## Tests

- Do changed tests express behavior rather than mirror implementation?
- Would each test fail before the fix or under a plausible regression?
- Are meaningful error and boundary paths covered at the right level?
- Watch for weakened/deleted assertions, broad snapshots, unconditional skips, swallowed errors, flaky timing, excessive mocking, and tests that pass without executing the target path.
- A missing test is a finding only when it leaves a meaningful regression risk; identify the exact behavior to test.

## Design and maintainability

Flag design issues only when they create a concrete correctness or maintenance cost in this change:

- Unnecessary complexity or speculative generality.
- Duplicated business rules that can diverge.
- Feature logic in the wrong owning layer.
- Broken module boundaries, circular dependencies, or hidden global state.
- Misleading names, comments, or docs that would cause incorrect use.
- Dead code or obsolete compatibility paths introduced or stranded by the change.
- Refactors that move complexity without reducing it.

Prefer the smallest remedy that removes the failure mode. Do not demand unrelated cleanup or a preferred style when local conventions permit the implementation.

## User and operational impact

- Check accessibility and keyboard/focus behavior for relevant UI changes.
- Check internationalization, locale, timezone, Unicode, and pluralization assumptions when relevant.
- Ensure observable behavior changes update local documentation, examples, config templates, diagnostics, and runbooks where users/operators depend on them.
- Check logging and errors for useful context without leaking sensitive values.
