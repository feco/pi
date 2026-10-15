# Documentation review

Check that what users, operators, and future maintainers read still matches the code.

- When observable behavior changes, check the local documentation, README, examples, config templates, CLI help, diagnostics, changelog, and runbooks that describe it.
- When public APIs, flags, environment variables, or config keys are added or changed, check that they are documented where the repository documents their siblings.
- Check that changed docstrings and comments describe the new behavior, not the old one.
- When the repository records decisions (ADRs or design docs), check whether the change contradicts one without updating it.
- Follow the repository's documentation rules: frontmatter, required sections, link checks, and generated-doc sources.

Report a missing doc only where the repository's conventions or its users would expect one.
