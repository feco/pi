# Test review

Review the tests the change adds, edits, or should have touched.

- Do changed tests express behavior through public interfaces rather than mirror the implementation?
- Would each test fail before the fix or under a plausible regression? Try a one-line mutation of the changed code in your head: if the suite stays green, coverage is missing.
- Are meaningful error and boundary paths covered at the right level?
- Watch for weakened or deleted assertions, tautological expected values recomputed the way the code computes them, broad snapshots, unconditional skips, swallowed errors, flaky timing, excessive mocking of internal collaborators, and tests that pass without executing the target path.
- A missing test is a finding only when it leaves a meaningful regression risk; identify the exact behavior to test and the seam to test it at.
