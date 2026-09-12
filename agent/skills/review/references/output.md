# Review output contract

## Findings

Order findings by severity, then confidence. Use one item per independent root cause:

```markdown
- [P1] Short imperative title — `path/to/file.ext:42-47`
  When <trigger>, <what fails and impact>. <Why current code permits it>. Fix by <practical direction>.
```

Severity:

- **P0 — Critical:** reliably catastrophic or actively exploitable; data loss, broad compromise, or system-wide outage. Blocks use immediately.
- **P1 — High:** concrete correctness/security failure affecting normal or important scenarios. Should be fixed before accepting the change.
- **P2 — Medium:** real defect under a narrower scenario, meaningful regression risk, or important missing regression coverage.
- **P3 — Low:** small but concrete issue worth fixing. Do not use for subjective style or speculative improvement.

A finding must be:

- Introduced or materially worsened by the reviewed change.
- Specific and actionable, with a concrete trigger and impact.
- Supported by repository evidence, not guesswork.
- Located on the smallest useful changed-line range (prefer 1–5 lines).
- Self-contained; do not require the author to infer the bug.

Do not include praise, nits, generic checklists, or multiple unrelated problems in one finding. If uncertain, label it `Question:` outside the findings and state what evidence is missing; do not inflate its severity.

## Summary

After findings, include:

```markdown
## Summary
- **Verdict:** Acceptable / Needs changes / Blocked
- **Scope:** resolved commit(s) or local change set reviewed
- **What changed:** 1–3 sentences
- **Verification:** exact checks run and results, or "Static review only; tests not run"
- **Residual risk:** unreviewed generated/binary files, missing spec, unavailable environment, stale local remote-tracking ref, or other material limitation
```

Verdict rules:

- `Blocked`: any P0.
- `Needs changes`: any P1 or P2.
- `Acceptable`: no P0–P2; P3 findings may remain.

If there are no findings, write `No actionable defects found.` before the summary. This means no qualifying defects were identified—not that the change is proven correct.
