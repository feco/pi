# Review output contract

The report has four parts, in this order: defects, improvements, open questions, and the summary.

## Defects

Correctness, security, performance, test-coverage, and spec issues. Order by severity, then confidence. Use one item per independent root cause:

```markdown
- [P1] Short imperative title — `path/to/file.ext:42-47` (confirmed | plausible)
  When <trigger>, <what fails and impact>. <Why current code permits it>. Evidence: <reproduction, exploit path, failing test, or measurement>. Guards checked: <what you searched>. Fix by <practical direction>.
```

Mark a finding **confirmed** when you ran a failing test, input, or measurement that shows it, and **plausible** when the evidence is reasoning only.

Severity:

- **P0 — Critical:** reliably catastrophic or actively exploitable; data loss, broad compromise, or system-wide outage. Blocks use immediately.
- **P1 — High:** concrete correctness/security failure affecting normal or important scenarios. Should be fixed before accepting the change.
- **P2 — Medium:** real defect under a narrower scenario, meaningful regression risk, or important missing regression coverage.
- **P3 — Low:** small but concrete issue worth fixing, including security hardening that relies on a single distant guard.

## Improvements

Clarity, maintainability, documentation, and standards issues. They carry no severity and never change the verdict. Use one item per root cause:

```markdown
- Short imperative title — `path/to/file.ext:42-47`
  <The concrete misreading, cost, contradicting doc passage, or broken rule with its source>. Fix by <practical direction>.
```

## Rules for every finding

- Introduced or materially worsened by the reviewed change.
- Specific and actionable, with the evidence its category requires.
- Supported by repository evidence, not guesswork.
- Located on the smallest useful changed-line range (prefer 1–5 lines), or the nearest changed line when it manifests in unchanged context.
- Self-contained; do not require the author to infer the issue.
- Spec and standards findings cite their authoritative local source.

Do not include praise, nits, generic checklists, or multiple unrelated problems in one finding.

## Open questions

Plausible issues you could not back with evidence, and requirement questions. For each, state the suspected issue, its location, and the evidence that would confirm or dismiss it. Do not assign severity.

## Summary

```markdown
## Summary
- **Verdict:** Acceptable / Needs changes / Blocked
- **Scope:** resolved commit(s) or local change set reviewed
- **What changed:** 1–3 sentences
- **Passes:** one line per pass, with its finding count or "nothing in scope"
- **Verification:** exact checks run and results, or "Static review only; tests not run"
- **Residual risk:** unreviewed generated/binary files, missing spec, unavailable environment, stale local remote-tracking ref, or other material limitation
```

Verdict rules, from defects only:

- `Blocked`: any P0.
- `Needs changes`: any P1 or P2.
- `Acceptable`: no P0–P2 defects; P3 defects, improvements, and open questions may remain.

If there are no findings, write `No actionable issues found.` before the summary. This means no qualifying issues were identified, not that the change is proven correct.
