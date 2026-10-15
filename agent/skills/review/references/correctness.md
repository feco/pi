# Correctness review

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

## User and operational impact

- Check accessibility and keyboard/focus behavior for relevant UI changes.
- Check internationalization, locale, timezone, Unicode, and pluralization assumptions when relevant.
- Check logging and errors for useful context without leaking sensitive values.
